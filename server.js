
const express = require("express");
const fs = require("fs");
const path = require("path");


const Config = {
  PATIENTS_FILE: path.join(__dirname, "data", "patients.csv"),
  RESOURCES_FILE: path.join(__dirname, "data", "resources.txt"),
  ADMIN_PASSWORD: "admin123",
  CRITICAL_TREATMENT_MS: 45000,  // 15 seconds
  SERIOUS_TREATMENT_MS: 40000,   // 10 seconds
  NORMAL_TREATMENT_MS: 35000,     // 5 seconds
};


function getCurrentTimestamp() {
  const now = new Date();
  const pad = (n) => (n < 10 ? `0${n}` : `${n}`);
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(
    now.getDate()
  )} ${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(
    now.getSeconds()
  )}`;
}

function severityToString(sev) {
  if (sev >= 3) return "CRITICAL";
  if (sev === 2) return "SERIOUS";
  return "NORMAL";
}

function intToSeverity(x) {
  return x >= 3 ? 3 : x === 2 ? 2 : 1;
}

function escapeCSV(s) {
  if (s == null) return "";
  return String(s).replace(/"/g, '""');
}

function unescapeCSV(s) {
  if (s == null) return "";
  return String(s).replace(/""/g, '"');
}

function severityTreatmentMs(sev) {
  if (sev >= 3) return Config.CRITICAL_TREATMENT_MS;
  if (sev === 2) return Config.SERIOUS_TREATMENT_MS;
  return Config.NORMAL_TREATMENT_MS;
}

function generatePrescription(patient) {
  let base = "";
  if (patient.severity >= 3)
    base = "ICU Medications + Broad-Spectrum Antibiotics";
  else if (patient.severity === 2)
    base = "Analgesics + Continuous Monitoring";
  else base = "Rest + Paracetamol 500mg";
  if (patient.requiresVentilator)
    base += " | Ventilator Support Required";
  return base;
}


function patientToCSV(p) {
  return [
    p.id,
    `"${escapeCSV(p.name)}"`,
    p.age,
    `"${escapeCSV(p.complaint)}"`,
    p.severity,
    p.status,
    p.assignedBed,
    p.requiresVentilator ? 1 : 0,
    p.assignedVentilator,
    p.enqueuedSequence,
    `"${p.registrationTime}"`,
    p.treatmentDurationMs,
    `"${escapeCSV(p.prescription || "")}"`,
  ].join(",");
}

function parseCSVLine(line) {
  const out = [];
  let cur = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') {
      if (!inQuotes) {
        inQuotes = true;
      } else if (i + 1 < line.length && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else {
        inQuotes = false;
      }
    } else if (c === "," && !inQuotes) {
      out.push(cur);
      cur = "";
    } else {
      cur += c;
    }
  }
  out.push(cur);
  return out;
}

function patientFromCSVLine(line) {
  const fields = parseCSVLine(line);
  if (fields.length < 13) return null;
  const p = {
    id: parseInt(fields[0], 10),
    name: unescapeCSV(fields[1]),
    age: parseInt(fields[2], 10),
    complaint: unescapeCSV(fields[3]),
    severity: intToSeverity(parseInt(fields[4], 10)),
    status: fields[5],
    assignedBed: parseInt(fields[6], 10),
    requiresVentilator: parseInt(fields[7], 10) !== 0,
    assignedVentilator: parseInt(fields[8], 10),
    enqueuedSequence: parseInt(fields[9], 10),
    registrationTime: unescapeCSV(fields[10]),
    treatmentDurationMs: parseInt(fields[11], 10),
    prescription: unescapeCSV(fields[12]),
  };
  return p;
}


const Resources = {
  totalBeds: 0,
  usedBeds: 0,
  totalVentilators: 0,
  usedVentilators: 0,

  setTotals(beds, vents) {
    Resources.totalBeds = beds;
    Resources.totalVentilators = vents;
    Resources.usedBeds = Math.min(Resources.usedBeds, Resources.totalBeds);
    Resources.usedVentilators = Math.min(
      Resources.usedVentilators,
      Resources.totalVentilators
    );
  },

  allocateBed() {
    if (Resources.usedBeds < Resources.totalBeds) {
      Resources.usedBeds++;
      return Resources.usedBeds;
    }
    return -1;
  },

  releaseBed(idx) {
    if (Resources.usedBeds > 0) Resources.usedBeds--;
  },

  allocateVentilator() {
    if (Resources.usedVentilators < Resources.totalVentilators) {
      Resources.usedVentilators++;
      return Resources.usedVentilators;
    }
    return -1;
  },

  releaseVentilator(idx) {
    if (Resources.usedVentilators > 0) Resources.usedVentilators--;
  },

  availableBeds() {
    return Resources.totalBeds - Resources.usedBeds;
  },

  availableVentilators() {
    return Resources.totalVentilators - Resources.usedVentilators;
  },

  saveToFile() {
    fs.mkdirSync(path.dirname(Config.RESOURCES_FILE), { recursive: true });
    fs.writeFileSync(
      Config.RESOURCES_FILE,
      `${Resources.totalBeds},${Resources.totalVentilators}\n`,
      "utf8"
    );
  },

  loadFromFile() {
    try {
      const txt = fs.readFileSync(Config.RESOURCES_FILE, "utf8").trim();
      if (!txt) return;
      const [bedsStr, ventsStr] = txt.split(",");
      Resources.totalBeds = parseInt(bedsStr, 10) || 0;
      Resources.totalVentilators = parseInt(ventsStr, 10) || 0;
    } catch {
      // First run: no file yet
    }
  },
};


let patientRecords = new Map();
let waitingQueue = [];
let readyQueue = [];
let systemRunning = false;
let numberOfDoctors = 0;
let sequenceCounter = 0;
let nextPatientId = 1;
const activeTreatmentTimers = new Map();


function sortWaitingQueue() {
  waitingQueue.sort((a, b) => {
    if (a.patient.severity !== b.patient.severity) {
      return b.patient.severity - a.patient.severity;
    }
    return a.sequence - b.sequence;
  });
}


function tryAllocateResources() {
  let progressed = false;
  while (waitingQueue.length > 0) {
    const top = waitingQueue[0];
    const p = top.patient;

    const bedIndex = Resources.allocateBed();
    if (bedIndex === -1) {
      break;
    }

    waitingQueue.shift();

    let ventIndex = -1;
    if (p.requiresVentilator) {
      ventIndex = Resources.allocateVentilator();
      if (ventIndex === -1) {
        Resources.releaseBed(bedIndex);
        waitingQueue.unshift(top);
        break;
      }
    }

    const rec = patientRecords.get(p.id);
    if (rec) {
      rec.assignedBed = bedIndex;
      rec.assignedVentilator = ventIndex;
      rec.status = "Allocated";
      patientRecords.set(p.id, rec);
    }

    readyQueue.push(p.id);
    progressed = true;
  }
  if (progressed) savePatientsToFile();
}


function startDoctorWorkers() {
  if (systemRunning) {
    console.log('[System] Doctor workers already running');
    return;
  }
  
  systemRunning = true;
  console.log(`[Process Manager] Creating ${numberOfDoctors} doctor processes...`);

  for (let i = 0; i < numberOfDoctors; i++) {
    const doctorId = i + 1;
    
    const doctorLoop = async () => {
      console.log(`[Doctor ${doctorId}] Process created - State: READY`);
      
      while (systemRunning) {
        const pid = readyQueue.shift();
        
        if (!pid) {
          await new Promise((res) => setTimeout(res, 500));
          continue;
        }

        const p = patientRecords.get(pid);
        if (!p) continue;

        p.status = "In-Treatment";
        patientRecords.set(pid, p);
        savePatientsToFile();

        console.log(`[Doctor ${doctorId}] 🏥 State: RUNNING | Treating Patient #${pid} (${p.name}, ${severityToString(p.severity)}) - ${p.treatmentDurationMs}ms`);

        await new Promise((resolve) => {
          const handle = setTimeout(() => {
            const rec = patientRecords.get(pid);
            if (rec) {
              rec.prescription = generatePrescription(rec);
              rec.status = "Discharged";
              
              if (rec.assignedBed !== -1) {
                Resources.releaseBed(rec.assignedBed);
                rec.assignedBed = -1;
              }
              if (rec.assignedVentilator !== -1) {
                Resources.releaseVentilator(rec.assignedVentilator);
                rec.assignedVentilator = -1;
              }
              
              patientRecords.set(pid, rec);
              savePatientsToFile();
              
              console.log(`[Doctor ${doctorId}] ✅ Discharged Patient #${pid} (${rec.name})`);
              
              tryAllocateResources();
            }
            
            activeTreatmentTimers.delete(pid);
            resolve();
          }, p.treatmentDurationMs);

          activeTreatmentTimers.set(pid, handle);
        });
      }
      
      console.log(`[Doctor ${doctorId}] Process terminated - State: TERMINATED`);
    };
    
    doctorLoop();
  }
  
  console.log(`[Process Manager] 🚀 Started ${numberOfDoctors} doctor processes in parallel mode`);
}

function stopDoctorWorkers() {
  if (!systemRunning) return;
  
  console.log('[Process Manager] Sending termination signal to all doctor processes...');
  systemRunning = false;
  
  for (const [pid, handle] of activeTreatmentTimers.entries()) {
    clearTimeout(handle);
    console.log(`[Process Manager] Cleaned up timer for Patient ${pid}`);
  }
  activeTreatmentTimers.clear();
  
  console.log('[Process Manager] All doctor processes terminated');
}


function registerPatient({
  name,
  age,
  complaint, 
  severity,
  requiresVentilator,
}) {
  const p = {
    id: nextPatientId++,
    name: String(name || ""),
    age: Number(age || 0),
    complaint: String(complaint || ""),
    severity: intToSeverity(Number(severity || 1)),
    status: "Waiting",
    assignedBed: -1,
    assignedVentilator: -1,
    requiresVentilator: !!requiresVentilator,
    enqueuedSequence: sequenceCounter++,
    registrationTime: getCurrentTimestamp(),
    treatmentDurationMs: severityTreatmentMs(
      intToSeverity(Number(severity || 1))
    ),
    prescription: "",
  };

  patientRecords.set(p.id, p);
  waitingQueue.push({ patient: p, sequence: p.enqueuedSequence });
  sortWaitingQueue();

  const availBeds = Resources.availableBeds();
  const availVents = Resources.availableVentilators();

  tryAllocateResources();

  const updated = patientRecords.get(p.id);
  savePatientsToFile();

  return {
    ...updated,
    info: {
      hadBedBefore: availBeds > 0,
      hadVentsBefore: availVents > 0,
      allocated: updated.status === "Allocated",
    },
  };
}

function dischargePatient(id) {
  const p = patientRecords.get(id);
  if (!p) return false;

  if (p.assignedBed !== -1) {
    Resources.releaseBed(p.assignedBed);
    p.assignedBed = -1;
  }
  if (p.assignedVentilator !== -1) {
    Resources.releaseVentilator(p.assignedVentilator);
    p.assignedVentilator = -1;
  }
  p.status = "Discharged";
  patientRecords.set(id, p);
  savePatientsToFile();
  tryAllocateResources();
  return true;
}

function computeSnapshot() {
  const totals = {
    totalBeds: Resources.totalBeds,
    availableBeds: Resources.availableBeds(),
    totalVentilators: Resources.totalVentilators,
    availableVentilators: Resources.availableVentilators(),
  };
  let waiting = 0,
    allocated = 0,
    inTreatment = 0,
    discharged = 0;
  for (const p of patientRecords.values()) {
    if (p.status === "Waiting") waiting++;
    else if (p.status === "Allocated") allocated++;
    else if (p.status === "In-Treatment") inTreatment++;
    else if (p.status === "Discharged") discharged++;
  }
  return {
    ...totals,
    waitingQueueSize: waitingQueue.length,
    stats: {
      waiting,
      allocated,
      inTreatment,
      discharged,
      total: patientRecords.size,
    },
  };
}


function savePatientsToFile() {
  const patients = Array.from(patientRecords.values()).sort(
    (a, b) => a.id - b.id
  );
  fs.mkdirSync(path.dirname(Config.PATIENTS_FILE), { recursive: true });
  const header =
    "id,name,age,complaint,severity,status,assignedBed,needsVent,assignedVent,enqueue_seq,registered_time,treatment_ms,prescription\n";
  const lines = [header, ...patients.map(patientToCSV)];
  fs.writeFileSync(Config.PATIENTS_FILE, lines.join("\n"), "utf8");
}

function loadPatientsFromFile() {
  try {
    const txt = fs.readFileSync(Config.PATIENTS_FILE, "utf8");
    const lines = txt.split(/\r?\n/);
    if (lines.length <= 1) return;

    patientRecords.clear();
    waitingQueue = [];
    readyQueue = [];
    let maxId = 0;

    for (let i = 1; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line) continue;
      const p = patientFromCSVLine(line);
      if (!p) continue;

      patientRecords.set(p.id, p);
      if (p.id > maxId) maxId = p.id;

      if (p.assignedBed !== -1) {
        if (Resources.usedBeds < Resources.totalBeds) Resources.usedBeds++;
      }
      if (p.assignedVentilator !== -1) {
        if (Resources.usedVentilators < Resources.totalVentilators)
          Resources.usedVentilators++;
      }

      if (p.status === "Allocated") {
        readyQueue.push(p.id);
      } else if (p.status === "Waiting") {
        waitingQueue.push({
          patient: p,
          sequence: p.enqueuedSequence || 0,
        });
      }
      if (
        p.enqueuedSequence != null &&
        p.enqueuedSequence >= sequenceCounter
      ) {
        sequenceCounter = p.enqueuedSequence + 1;
      }
    }
    nextPatientId = maxId + 1;
    sortWaitingQueue();
  } catch {
    // First run
  }
}


const triageKeywords = {
  critical: {
    keywords: [
      'chest pain', 'heart attack', 'stroke', 'unconscious', 'not breathing',
      'severe bleeding', 'head injury', 'seizure', 'overdose', 'suicide',
      'stabbed', 'gunshot', 'can\'t breathe', 'choking', 'anaphylaxis',
      'severe burn', 'unresponsive', 'cardiac arrest', 'heavy bleeding'
    ],
    ventilatorKeywords: ['can\'t breathe', 'choking', 'respiratory', 'pneumonia severe', 'asthma attack']
  },
  serious: {
    keywords: [
      'broken bone', 'fracture', 'high fever', 'severe pain', 'vomiting blood',
      'difficulty breathing', 'severe headache', 'abdominal pain', 'dehydration',
      'infection', 'deep cut', 'allergic reaction', 'asthma', 'pneumonia',
      'kidney stone', 'appendicitis', 'diabetic', 'blood sugar'
    ],
    ventilatorKeywords: ['difficulty breathing', 'asthma', 'pneumonia']
  },
  normal: {
    keywords: [
      'cold', 'cough', 'fever mild', 'headache', 'minor cut', 'sprain',
      'flu', 'sore throat', 'rash', 'nausea', 'diarrhea', 'earache',
      'toothache', 'back pain mild', 'insect bite', 'minor burn'
    ],
    ventilatorKeywords: []
  }
};

function analyzeTriage(complaint) {
  const lower = complaint.toLowerCase();
  let severity = 1;
  let confidence = 0;
  let matchedKeywords = [];
  let requiresVentilator = false;

  // Check critical
  for (const keyword of triageKeywords.critical.keywords) {
    if (lower.includes(keyword)) {
      severity = 3;
      confidence = 95;
      matchedKeywords.push(keyword);
    }
  }

  // Check serious
  if (severity !== 3) {
    for (const keyword of triageKeywords.serious.keywords) {
      if (lower.includes(keyword)) {
        severity = 2;
        confidence = 85;
        matchedKeywords.push(keyword);
      }
    }
  }

  // Check normal
  if (severity === 1) {
    for (const keyword of triageKeywords.normal.keywords) {
      if (lower.includes(keyword)) {
        confidence = 75;
        matchedKeywords.push(keyword);
      }
    }
  }

  // Check ventilator requirement
  const allVentKeywords = [
    ...triageKeywords.critical.ventilatorKeywords,
    ...triageKeywords.serious.ventilatorKeywords
  ];
  
  for (const keyword of allVentKeywords) {
    if (lower.includes(keyword)) {
      requiresVentilator = true;
      break;
    }
  }

  if (matchedKeywords.length === 0) {
    matchedKeywords = ['general symptoms'];
    confidence = 50;
  }

  return {
    severity,
    confidence,
    matchedKeywords: matchedKeywords.slice(0, 3),
    requiresVentilator,
    message: `AI suggests ${severity === 3 ? 'CRITICAL' : severity === 2 ? 'SERIOUS' : 'NORMAL'} severity`
  };
}


Resources.loadFromFile();
loadPatientsFromFile();


const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

function adminGuard(req, res, next) {
  const pw = req.header("x-admin-password");
  if (pw === Config.ADMIN_PASSWORD) return next();
  return res.status(401).json({ error: "Unauthorized" });
}


app.post("/api/patients", (req, res) => {
  try {
    const { name, age, complaint, severity, requiresVentilator } =
      req.body || {};
    if (!name || age == null || !complaint || severity == null) {
      return res
        .status(400)
        .json({ error: "name, age, complaint, severity required" });
    }
    const created = registerPatient({
      name,
      age,
      complaint,
      severity,
      requiresVentilator,
    });
    return res.json(created);
  } catch (e) {
    return res
      .status(500)
      .json({ error: "Registration failed", details: String(e) });
  }
});

app.get("/api/patients", (req, res) => {
  const pts = Array.from(patientRecords.values()).sort(
    (a, b) => a.id - b.id
  );
  res.json(pts);
});

app.post("/api/patients/:id/discharge", adminGuard, (req, res) => {
  const id = Number(req.params.id);
  const ok = dischargePatient(id);
  if (!ok) return res.status(404).json({ error: "Patient not found" });
  res.json({ success: true });
});

app.get("/api/snapshot", (req, res) => {
  res.json(computeSnapshot());
});

app.post("/api/resources/configure", adminGuard, (req, res) => {
  const { beds, ventilators, doctors } = req.body || {};
  const b = Number(beds ?? 0);
  const v = Number(ventilators ?? 0);
  const d = Number(doctors ?? numberOfDoctors);
  Resources.setTotals(b, v);
  Resources.saveToFile();
  numberOfDoctors = d;
  return res.json({
    success: true,
    totals: { beds: b, ventilators: v, doctors: d },
  });
});

app.post("/api/doctors/start", adminGuard, (req, res) => {
  if (Resources.totalBeds === 0) {
    return res.status(400).json({ error: "No resources configured" });
  }
  if (systemRunning) {
    return res.json({
      success: true,
      message: "Doctor workers already running",
    });
  }
  startDoctorWorkers();
  return res.json({ success: true, started: numberOfDoctors });
});

app.post("/api/shutdown", adminGuard, (req, res) => {
  stopDoctorWorkers();
  res.json({ success: true });
});

app.get("/api/queue/position/:id", (req, res) => {
  const id = Number(req.params.id);
  sortWaitingQueue();
  let pos = 0;
  let found = false;
  for (const wp of waitingQueue) {
    if (wp.patient.id === id) {
      found = true;
      break;
    }
    pos++;
  }
  if (!found) return res.json({ inQueue: false, position: -1 });
  res.json({ inQueue: true, position: pos });
});

app.post('/api/ai/triage', (req, res) => {
  const { complaint } = req.body || {};
  
  if (!complaint || complaint.trim().length < 5) {
    return res.status(400).json({ error: 'Complaint too short for analysis' });
  }

  const analysis = analyzeTriage(complaint);
  res.json(analysis);
});


const PORT = 3000;
app.listen(PORT, () => {
  console.log(`ER Management System server running at http://localhost:${PORT}`);
  console.log(`Login Page: http://localhost:${PORT}/`);
  console.log(`User Dashboard: http://localhost:${PORT}/user.html`);
  console.log(`Admin Dashboard: http://localhost:${PORT}/admin.html`);
});
