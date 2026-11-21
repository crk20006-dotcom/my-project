import type { EngineeringDisciplineId } from './interfaces.ts';

export interface MaterialSpec {
  id: string;
  name: string;
  category: 'steel' | 'aluminum' | 'titanium' | 'copper' | 'polymer' | 'concrete';
  density_kg_m3: number;
  youngs_modulus_gpa: number;
  yield_strength_mpa: number;
  ultimate_strength_mpa: number;
  poissons_ratio: number;
  thermal_conductivity_w_mk: number;
  notes: string;
}

export const ENGINEERING_MATERIALS: MaterialSpec[] = [
  {
    id: 'steel-1045',
    name: 'AISI 1045 Medium Carbon Steel (Hot-Rolled)',
    category: 'steel',
    density_kg_m3: 7850,
    youngs_modulus_gpa: 205,
    yield_strength_mpa: 310,
    ultimate_strength_mpa: 565,
    poissons_ratio: 0.29,
    thermal_conductivity_w_mk: 49.8,
    notes: 'Standard shafting, gears, bolts, and general structural transmission components.',
  },
  {
    id: 'steel-4140',
    name: 'AISI 4140 Chromoly Alloy Steel (Q&T)',
    category: 'steel',
    density_kg_m3: 7850,
    youngs_modulus_gpa: 210,
    yield_strength_mpa: 655,
    ultimate_strength_mpa: 1020,
    poissons_ratio: 0.29,
    thermal_conductivity_w_mk: 42.6,
    notes: 'High-strength spindles, axles, heavy gears, and high-fatigue rotating shafts.',
  },
  {
    id: 'ss-304',
    name: '304 Austenitic Stainless Steel',
    category: 'steel',
    density_kg_m3: 8000,
    youngs_modulus_gpa: 193,
    yield_strength_mpa: 215,
    ultimate_strength_mpa: 505,
    poissons_ratio: 0.29,
    thermal_conductivity_w_mk: 16.2,
    notes: 'Corrosion-resistant process piping, pressure vessels, and chemical tanks.',
  },
  {
    id: 'al-6061-t6',
    name: 'Aluminum 6061-T6',
    category: 'aluminum',
    density_kg_m3: 2700,
    youngs_modulus_gpa: 68.9,
    yield_strength_mpa: 276,
    ultimate_strength_mpa: 310,
    poissons_ratio: 0.33,
    thermal_conductivity_w_mk: 167,
    notes: 'Lightweight CNC frames, enclosures, heatsinks, robotics brackets, and extrusions.',
  },
  {
    id: 'ti-6al4v',
    name: 'Titanium Ti-6Al-4V (Grade 5)',
    category: 'titanium',
    density_kg_m3: 4430,
    youngs_modulus_gpa: 113.8,
    yield_strength_mpa: 880,
    ultimate_strength_mpa: 950,
    poissons_ratio: 0.34,
    thermal_conductivity_w_mk: 6.7,
    notes: 'High strength-to-weight aerospace fasteners, impellers, and medical hardware.',
  },
  {
    id: 'copper-c110',
    name: 'Electrolytic Copper (C11000)',
    category: 'copper',
    density_kg_m3: 8890,
    youngs_modulus_gpa: 117,
    yield_strength_mpa: 69,
    ultimate_strength_mpa: 220,
    poissons_ratio: 0.34,
    thermal_conductivity_w_mk: 398,
    notes: 'Busbars, transformer windings, cold plates, and heat pipes.',
  },
  {
    id: 'abs-fdm',
    name: 'ABS Engineering Thermoplastic',
    category: 'polymer',
    density_kg_m3: 1040,
    youngs_modulus_gpa: 2.2,
    yield_strength_mpa: 41,
    ultimate_strength_mpa: 44,
    poissons_ratio: 0.35,
    thermal_conductivity_w_mk: 0.17,
    notes: 'Enclosures and prototypes; account for anisotropy in 3D-printed parts.',
  },
  {
    id: 'concrete-c30',
    name: 'Structural Concrete (C30/37 Compression)',
    category: 'concrete',
    density_kg_m3: 2400,
    youngs_modulus_gpa: 33,
    yield_strength_mpa: 30,
    ultimate_strength_mpa: 37,
    poissons_ratio: 0.2,
    thermal_conductivity_w_mk: 1.4,
    notes: 'Compressive cylinder strength f_ck = 30 MPa; negligible unreinforced tensile capacity.',
  },
];

export interface DisciplineReference {
  id: EngineeringDisciplineId;
  name: string;
  overview: string;
  core_principles: string[];
  key_formulas: Array<{ name: string; equation: string; variables: string }>;
  assumptions: string[];
  worked_example: {
    problem: string;
    given: string[];
    steps: string[];
    answer: string;
  };
  practical_applications: string[];
}

export const ENGINEERING_DISCIPLINES: DisciplineReference[] = [
  {
    id: 'mechanical',
    name: 'Mechanical Engineering',
    overview: 'Covers rigid-body statics, dynamics, mechanics of materials, heat transfer, and thermodynamics for structures and mechanisms.',
    core_principles: [
      'Equilibrium of forces and moments (ΣF = 0, ΣM = 0) before sizing cross-sections.',
      'Separate yield failure (ductile von Mises / Tresca) from brittle fracture and Euler column buckling.',
      'Validate thermal expansion ΔL = α L ΔT whenever mating steel and aluminum parts.',
    ],
    key_formulas: [
      { name: 'Axial Normal Stress', equation: 'σ = F / A', variables: 'σ (Pa), F (N), A (m²)' },
      { name: 'Hooke’s Law', equation: 'ε = σ / E,  δ = (F · L) / (A · E)', variables: 'E: Young’s modulus (Pa), δ: elongation (m)' },
      { name: 'Fourier Conduction', equation: 'q = -k · A · (ΔT / Δx)', variables: 'k: thermal conductivity (W/m·K)' },
    ],
    assumptions: [
      'Linear-elastic, isotropic, homogeneous material behavior below the proportional limit.',
      'St. Venant’s principle applies away from sharp stress concentrations or pinned supports.',
    ],
    worked_example: {
      problem: 'Check tensile elongation of a 0.5 m long, 12 mm diameter 6061-T6 rod under a 15 kN load.',
      given: ['F = 15,000 N', 'L = 0.5 m', 'd = 0.012 m => A = 1.131e-4 m²', 'E = 68.9 GPa'],
      steps: [
        'Stress: σ = 15,000 / 1.13097e-4 = 132.63 MPa',
        'Yield Factor of Safety (Sy = 276 MPa): n = 276 / 132.63 = 2.08',
        'Elongation: δ = (15,000 × 0.5) / (1.13097e-4 × 68.9e9) = 0.962 mm',
      ],
      answer: 'σ = 132.63 MPa, FoS = 2.08, δ = 0.962 mm (linearly elastic).',
    },
    practical_applications: ['Structural brackets and load cells', 'Thermal management cold plates', 'Vibration isolation mounts'],
  },
  {
    id: 'electrical',
    name: 'Electrical & Electronics Engineering',
    overview: 'Covers DC/AC circuit laws, phasor impedance, RLC resonance, filtering, power factor, and thermal dissipation in conductors.',
    core_principles: [
      'Enforce Kirchhoff’s Current Law (KCL) and Voltage Law (KVL) in steady-state and transient domains.',
      'Account for reactive power (var) vs active power (W) via complex impedance Z = R + jX.',
      'Verify peak resistor/MOSFET power dissipation I²R against package thermal derating curves.',
    ],
    key_formulas: [
      { name: 'Series RLC Impedance', equation: 'Z = √(R² + (ωL - 1/(ωC))²)', variables: 'ω = 2πf (rad/s)' },
      { name: 'Resonant Frequency', equation: 'f₀ = 1 / (2π √(LC))', variables: 'L (H), C (F)' },
      { name: 'RC Time Constant', equation: 'τ = R · C', variables: '63.2% step charge at t = τ; ~99.3% at 5τ' },
    ],
    assumptions: [
      'Lumped-element circuit approximation holds (physical trace length ≪ signal wavelength λ).',
      'Linear time-invariant passive components at nominal ambient temperature (25 °C).',
    ],
    worked_example: {
      problem: 'Find impedance and resonant frequency of a series circuit with R = 22 Ω, L = 10 mH, C = 10 μF at 1 kHz.',
      given: ['R = 22 Ω', 'L = 0.01 H', 'C = 10e-6 F', 'f = 1000 Hz (ω = 6283.19 rad/s)'],
      steps: [
        'X_L = ωL = 62.83 Ω;  X_C = 1/(ωC) = 15.92 Ω;  X_net = 46.92 Ω',
        '|Z| = √(22² + 46.92²) = 51.82 Ω, phase φ = +64.88° (inductive)',
        'f₀ = 1 / (2π√(0.01 × 1e-5)) = 503.29 Hz',
      ],
      answer: '|Z| = 51.82 Ω (PF = 0.425 lagging), f₀ = 503.29 Hz.',
    },
    practical_applications: ['LC power supply output filters', 'Motor drive impedance matching', 'PCB trace resistance & voltage drop budgets'],
  },
  {
    id: 'civil',
    name: 'Civil & Structural Engineering',
    overview: 'Covers beam bending moments, shear forces, mid-span deflection limits (L/360), foundation bearing pressure, and open-channel hydraulics.',
    core_principles: [
      'Check serviceability (deflection limits such as L/360 or L/240) independently of ultimate strength limits.',
      'Combine dead, live, wind, and seismic load cases using governing building code load factors.',
      'Verify soil bearing pressure q = P / A stays below allowable geotechnical capacity.',
    ],
    key_formulas: [
      { name: 'Point-Loaded Simply Supported Beam', equation: 'M_max = P·L / 4,  δ_max = (P·L³) / (48·E·I)', variables: 'L: span (m), I: second moment of area (m⁴)' },
      { name: 'Rectangular Beam Flexure', equation: 'I = b·h³ / 12,  σ_b = (M · y) / I', variables: 'b: width, h: height, y = h/2' },
      { name: 'Manning Open-Channel Flow', equation: 'v = (1/n) · R_h^(2/3) · S^(1/2)', variables: 'n: roughness, R_h: hydraulic radius, S: slope' },
    ],
    assumptions: [
      'Euler-Bernoulli beam theory (plane sections remain plane, shear deformation negligible for L/h > 10).',
      'Unfactored service load check; certified design requires local building code combinations (Eurocode / ASCE 7).',
    ],
    worked_example: {
      problem: 'Check max bending stress and deflection of a 4 m steel rectangular beam (b=60 mm, h=160 mm, E=205 GPa) carrying a 12 kN center point load.',
      given: ['P = 12,000 N', 'L = 4.0 m', 'I = 0.06 × 0.16³ / 12 = 2.048e-5 m⁴'],
      steps: [
        'M_max = 12,000 × 4 / 4 = 12,000 N·m',
        'σ_b = 12,000 × 0.08 / 2.048e-5 = 46.88 MPa',
        'δ_max = (12,000 × 64) / (48 × 205e9 × 2.048e-5) = 3.81 mm (L / 1050 < L / 360)',
      ],
      answer: 'M_max = 12 kN·m, σ_b = 46.88 MPa, δ_max = 3.81 mm.',
    },
    practical_applications: ['Floor joist and crane girder sizing', 'Retaining wall overturning safety', 'Stormwater culvert drainage sizing'],
  },
  {
    id: 'computer_science',
    name: 'Computer Science & Software Engineering',
    overview: 'Covers algorithmic complexity (Big-O), parallel speedup bounds (Amdahl/Gustafson), queueing latency (Little’s Law), and memory throughput.',
    core_principles: [
      'Measure asymptotic complexity alongside constant-factor cache locality and I/O bottlenecks.',
      'Serial fractions bottleneck multi-core scaling according to Amdahl’s Law.',
      'Enforce invariants, input bounds, and deterministic error paths in safety-critical loops.',
    ],
    key_formulas: [
      { name: 'Amdahl’s Law Speedup', equation: 'S(N) = 1 / ((1 - p) + p / N)', variables: 'p: parallelizable fraction [0..1], N: cores' },
      { name: 'Little’s Law', equation: 'L = λ · W', variables: 'L: queue items, λ: arrival rate, W: mean latency' },
      { name: 'Memory Bandwidth Ceiling', equation: 'T_min = DataBytes / Bandwidth', variables: 'Roofline lower bound' },
    ],
    assumptions: [
      'Amdahl assumes fixed problem size and zero inter-thread synchronization overhead.',
      'Little’s Law requires a statistically stationary queue (λ < service rate μ).',
    ],
    worked_example: {
      problem: 'A pipeline spends 85% of runtime in parallelizable matrix ops. What is max speedup on 8 cores and infinite cores?',
      given: ['p = 0.85', 'Serial fraction 1 - p = 0.15', 'N = 8'],
      steps: [
        'At N = 8: S(8) = 1 / (0.15 + 0.85/8) = 1 / 0.25625 = 3.90×',
        'As N → ∞: S_max = 1 / 0.15 = 6.67×',
      ],
      answer: '3.90× speedup on 8 cores; hard ceiling of 6.67× regardless of core count.',
    },
    practical_applications: ['Concurrency & worker pool sizing', 'Database index & query complexity budgeting', 'Edge / 16 GB RAM CPU model profiling'],
  },
  {
    id: 'manufacturing',
    name: 'Manufacturing & Production Engineering',
    overview: 'Covers machining kinematics (spindle RPM, feed rate, MRR), Taylor tool life, process capability (Cp/Cpk), and Overall Equipment Effectiveness (OEE).',
    core_principles: [
      'Match surface cutting speed V_c to workpiece/cutter metallurgy before pushing chip load f_z.',
      'Track Cp (potential spread) separately from Cpk (process centering vs specification limits).',
      'Identify bottleneck station cycle time to establish line Takt time.',
    ],
    key_formulas: [
      { name: 'Spindle RPM', equation: 'N = (1000 · V_c) / (π · D)', variables: 'V_c (m/min), tool diameter D (mm)' },
      { name: 'Material Removal Rate', equation: 'MRR = w · a_p · v_f', variables: 'width w, depth a_p, table feed v_f (mm³/min)' },
      { name: 'Process Capability Cpk', equation: 'C_pk = min((USL - μ)/(3σ), (μ - LSL)/(3σ))', variables: 'Target C_pk ≥ 1.33' },
    ],
    assumptions: [
      'Rigid machine spindle setup without chatter or excessive radial runout.',
      'Cpk assumes an approximately normal, stable process distribution.',
    ],
    worked_example: {
      problem: 'Compute spindle speed and table feed for a 10 mm 4-flute carbide endmill at V_c = 180 m/min and chip load f_z = 0.05 mm/tooth.',
      given: ['D = 10 mm', 'V_c = 180 m/min', 'z = 4 flutes', 'f_z = 0.05 mm'],
      steps: [
        'N = (1000 × 180) / (π × 10) = 5,729.6 RPM',
        'Feed rate v_f = N × z × f_z = 5,729.6 × 4 × 0.05 = 1,145.9 mm/min',
      ],
      answer: '5,730 RPM at 1,146 mm/min table feed.',
    },
    practical_applications: ['CNC milling & lathe CAM toolpaths', 'Statistical Process Control (SPC)', 'Injection molding & additive cycle planning'],
  },
  {
    id: 'cad_3d',
    name: 'CAD & 3D Modelling Concepts',
    overview: 'Covers parametric feature trees, datum reference frames, sketch DOF constraints, B-rep vs STL mesh topology, and GD&T / fit tolerances.',
    core_principles: [
      'Constrain sketches around primary functional datums (A-B-C) so parametric edits propagate cleanly without broken references.',
      'Place fillets, chamfers, and drafts near the end of the feature tree after core solid topology stabilizes.',
      'Control STL export chord height & angle deviation when preparing curved surfaces for 3D printing or CAM.',
    ],
    key_formulas: [
      { name: 'STL Chord Approximation', equation: 'δ = R · (1 - cos(θ/2))', variables: 'Circle chord error δ for tessellation segment angle θ' },
      { name: 'ISO Fit Clearance', equation: 'C_min = Hole_min - Shaft_max', variables: 'Example H7/g6 sliding clearance fit' },
      { name: 'Cylindrical Tank Volume', equation: 'V = π · R² · H', variables: 'Solid mass = ρ · V' },
    ],
    assumptions: [
      'Project Genesis provides parametric geometry guidance and SVG 2D blueprints, not an interactive 3D B-rep CAD kernel.',
      'Fabrication tolerances depend on machine capability (e.g., CNC ±0.05 mm vs FDM ±0.20 mm).',
    ],
    worked_example: {
      problem: 'Check H7/g6 clearance for a 25 mm nominal bearing journal (25 H7: +0.021/0 mm; 25 g6: -0.007/-0.020 mm).',
      given: ['Hole: 25.000 to 25.021 mm', 'Shaft: 24.980 to 24.993 mm'],
      steps: [
        'Min clearance = 25.000 - 24.993 = +0.007 mm (+7 μm)',
        'Max clearance = 25.021 - 24.980 = +0.041 mm (+41 μm)',
      ],
      answer: 'Guaranteed precision sliding clearance between +7 μm and +41 μm.',
    },
    practical_applications: ['Parametric assembly design', 'GD&T inspection drawings (ASME Y14.5 / ISO 1101)', 'DFM & additive manufacturing prep'],
  },
  {
    id: 'fluid_power',
    name: 'Fluid Mechanics & Fluid Power',
    overview: 'Covers incompressible pipe flow, Reynolds regime classification, Darcy-Weisbach head loss, hydraulic actuators, and centrifugal pump sizing.',
    core_principles: [
      'Compute Reynolds number Re = ρvD/μ first; laminar (Re < 2300) and turbulent (Re > 4000) friction differ sharply.',
      'Distinguish hydraulic cylinder extend force (full bore area) vs retract force (annular area minus rod area).',
      'Check Net Positive Suction Head Available (NPSHa) to prevent pump cavitation.',
    ],
    key_formulas: [
      { name: 'Reynolds Number', equation: 'Re = (ρ · v · D) / μ', variables: 'ρ (kg/m³), v (m/s), D (m), μ (Pa·s)' },
      { name: 'Darcy-Weisbach Head Loss', equation: 'h_f = f · (L / D) · (v² / 2g)', variables: 'f: Darcy friction factor' },
      { name: 'Hydraulic Cylinder Force', equation: 'F = P · (π · D² / 4) · η', variables: 'P: working pressure (Pa), D: bore (m)' },
    ],
    assumptions: [
      'Steady, incompressible, Newtonian fluid flow inside rigid circular conduits (valid for Mach < 0.3 for gases).',
    ],
    worked_example: {
      problem: 'Compute extend force of an 80 mm bore hydraulic cylinder at 160 bar (16 MPa) assuming 95% mechanical efficiency.',
      given: ['D = 0.08 m => A = 5.0265e-3 m²', 'P = 16e6 Pa', 'η = 0.95'],
      steps: [
        'Theoretical force F_th = 16e6 × 5.0265e-3 = 80,425 N',
        'Net force F = 80,425 × 0.95 = 76,404 N (76.4 kN)',
      ],
      answer: '76.40 kN theoretical output force at 160 bar.',
    },
    practical_applications: ['Process piping pressure-drop sizing', 'Hydraulic press & excavator actuators', 'Pump station NPSH verification'],
  },
  {
    id: 'machine_design',
    name: 'Machine Design & Engineering Materials',
    overview: 'Covers combined bending/torsion shaft sizing, spur gear kinematics, bolted joints, bearing life, and material selection trade-offs.',
    core_principles: [
      'Combine steady torque and alternating bending stress using ASME/DE-Goodman or distortion-energy (von Mises) criteria.',
      'Verify keyway & shoulder fillet stress concentrations (K_t, K_f) on stepped rotating shafts.',
      'Compare specific strength (S_y / ρ) and specific stiffness (E / ρ) when choosing between steel, aluminum, and titanium.',
    ],
    key_formulas: [
      { name: 'ASME Equivalent Shaft Torque', equation: 'd³ = (32 · n / (π · S_y)) · √(M² + 0.75 · T²)', variables: 'Static DE yield sizing for bending M + torsion T' },
      { name: 'Spur Gear Pitch Diameter', equation: 'd = m · Z,  F_t = 2T / d', variables: 'm: metric module (mm), Z: teeth' },
      { name: 'Von Mises Equivalent Stress', equation: 'σ_vm = √(σ_x² + 3·τ_xy²)', variables: 'Ductile yield when σ_vm ≥ S_y' },
    ],
    assumptions: [
      'Preliminary static/yielding calculation; high-cycle rotating machinery additionally requires endurance limit S_e & notch sensitivity q analysis.',
    ],
    worked_example: {
      problem: 'Find tangential tooth force on a spur gear with module m = 3 mm and Z = 24 teeth transmitting T = 120 N·m.',
      given: ['m = 3 mm', 'Z = 24', 'T = 120 N·m'],
      steps: [
        'Pitch diameter d = m · Z = 3 × 24 = 72 mm = 0.072 m',
        'Tangential force F_t = (2 × 120) / 0.072 = 3,333.3 N',
      ],
      answer: 'd = 72 mm pitch diameter, F_t = 3.33 kN tangential tooth load.',
    },
    practical_applications: ['Gearbox & drivetrain shafts', 'Belt, chain, and coupling selection', 'Alloy & composite weight optimization'],
  },
];

export function findMaterialByIdOrName(query: string): MaterialSpec | undefined {
  const q = query.trim().toLowerCase();
  return ENGINEERING_MATERIALS.find(
    (m) => m.id.toLowerCase() === q || m.name.toLowerCase().includes(q)
  );
}
