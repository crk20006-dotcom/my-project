import React, { useEffect, useState } from 'react';
import {
  AlertTriangle,
  BookOpen,
  Bot,
  Calculator,
  CheckCircle2,
  Compass,
  Database,
  Download,
  FileText,
  FlaskConical,
  Layers,
  Loader2,
  Play,
  Plus,
  Ruler,
  ShieldAlert,
  Sigma,
  Trash2,
} from 'lucide-react';
import { apiClient, ApiRequestError } from '../../services/apiClient';
import type {
  DisciplineReferenceItem,
  EngineeringCalculationResponse,
  EngineeringCalculatorId,
  EngineeringDiagramKind,
  EngineeringDiagramResponse,
  EngineeringDisciplineId,
  EngineeringMaterialItem,
  EngineeringStatusResponse,
  MathComputationResponse,
  ScientificExperimentItem,
  SimulationRunResponse,
  SystemSettings,
} from '../../types/genesis';
import { EngineeringChartSvg } from '../common/EngineeringChartSvg';

interface GenesisEngineeringModuleProps {
  settings: SystemSettings | null;
}

type EngineeringTab =
  | 'calculator'
  | 'math'
  | 'disciplines'
  | 'design'
  | 'experiments'
  | 'simulation';

interface CalcFieldSpec {
  key: string;
  label: string;
  defaultValue: number;
  defaultUnit: string;
  units?: string[];
}

const CALCULATOR_DEFINITIONS: Array<{
  id: EngineeringCalculatorId;
  label: string;
  description: string;
  fields: CalcFieldSpec[];
}> = [
  {
    id: 'stress_strain',
    label: 'Stress, Strain & Yield FoS',
    description: 'Uniaxial normal stress σ = F/A, Hooke’s strain & elongation, and yield safety factor.',
    fields: [
      { key: 'force', label: 'Applied Axial Force', defaultValue: 15000, defaultUnit: 'N', units: ['N', 'kN', 'lbf'] },
      { key: 'area', label: 'Cross-Section Area', defaultValue: 113.1, defaultUnit: 'mm^2', units: ['mm^2', 'cm^2', 'm^2', 'in^2'] },
      { key: 'length', label: 'Member Length', defaultValue: 0.5, defaultUnit: 'm', units: ['m', 'mm', 'cm', 'in', 'ft'] },
      { key: 'modulus', label: 'Young’s Modulus (E)', defaultValue: 68.9, defaultUnit: 'GPa', units: ['GPa', 'MPa', 'psi'] },
      { key: 'yield_strength', label: 'Yield Strength (Sy)', defaultValue: 276, defaultUnit: 'MPa', units: ['MPa', 'GPa', 'psi'] },
    ],
  },
  {
    id: 'force_torque_power',
    label: 'Force, Torque & Power',
    description: 'Shaft torque τ = F·r, tangential speed, output/input mechanical power with efficiency.',
    fields: [
      { key: 'force', label: 'Tangential Force', defaultValue: 500, defaultUnit: 'N', units: ['N', 'kN', 'lbf'] },
      { key: 'radius', label: 'Lever / Pitch Radius', defaultValue: 0.25, defaultUnit: 'm', units: ['m', 'mm', 'in'] },
      { key: 'speed', label: 'Rotational Speed', defaultValue: 1200, defaultUnit: 'rpm', units: ['rpm', 'rad/s', 'Hz'] },
      { key: 'efficiency', label: 'Mechanical Efficiency (0–1)', defaultValue: 0.9, defaultUnit: '1' },
    ],
  },
  {
    id: 'motion_kinematics',
    label: 'Motion & Kinematics',
    description: 'Constant acceleration velocity, displacement, net force, and work-energy theorem balance.',
    fields: [
      { key: 'initial_velocity', label: 'Initial Velocity (v₀)', defaultValue: 2, defaultUnit: 'm/s', units: ['m/s', 'km/h', 'ft/s'] },
      { key: 'acceleration', label: 'Acceleration (m/s²)', defaultValue: 2.5, defaultUnit: '1' },
      { key: 'time', label: 'Elapsed Time (s)', defaultValue: 4, defaultUnit: 's' },
      { key: 'mass', label: 'Body Mass', defaultValue: 10, defaultUnit: 'kg', units: ['kg', 'g', 'lbm'] },
    ],
  },
  {
    id: 'thermodynamics',
    label: 'Thermodynamics & Ideal Gas',
    description: 'Carnot cycle maximum efficiency, cooling COP, and PV = nRT state solver.',
    fields: [
      { key: 't_hot', label: 'Hot Reservoir Temp (Th)', defaultValue: 550, defaultUnit: 'K', units: ['K', 'degC', 'degF'] },
      { key: 't_cold', label: 'Cold Reservoir Temp (Tc)', defaultValue: 300, defaultUnit: 'K', units: ['K', 'degC', 'degF'] },
      { key: 'pressure', label: 'Gas Pressure (P)', defaultValue: 101.325, defaultUnit: 'kPa', units: ['kPa', 'MPa', 'bar', 'psi'] },
      { key: 'volume', label: 'Chamber Volume (m³)', defaultValue: 0.05, defaultUnit: 'm^3' },
      { key: 'moles', label: 'Gas Amount (mol)', defaultValue: 2.0, defaultUnit: '1' },
    ],
  },
  {
    id: 'fluid_flow_pressure',
    label: 'Fluid Flow & Pressure Drop',
    description: 'Pipe velocity, Reynolds number classification, Haaland friction factor, and Darcy-Weisbach drop.',
    fields: [
      { key: 'diameter', label: 'Pipe Inner Diameter', defaultValue: 50, defaultUnit: 'mm', units: ['mm', 'm', 'in'] },
      { key: 'length', label: 'Pipe Length', defaultValue: 25, defaultUnit: 'm', units: ['m', 'ft'] },
      { key: 'flow_rate', label: 'Volumetric Flow Rate', defaultValue: 4.0, defaultUnit: 'L/s', units: ['L/s', 'L/min', 'm^3/s', 'gal/min'] },
      { key: 'density', label: 'Density (kg/m³)', defaultValue: 998, defaultUnit: '1' },
      { key: 'viscosity', label: 'Dynamic Viscosity (Pa·s)', defaultValue: 0.001, defaultUnit: '1' },
      { key: 'roughness', label: 'Absolute Roughness', defaultValue: 0.045, defaultUnit: 'mm', units: ['mm', 'm'] },
    ],
  },
  {
    id: 'pump_compressor',
    label: 'Pump & Hydraulic Head',
    description: 'Hydraulic pressure differential ΔP = ρgH, water power, and brake shaft power.',
    fields: [
      { key: 'flow_rate', label: 'Pump Flow Rate', defaultValue: 20, defaultUnit: 'L/s', units: ['L/s', 'L/min', 'm^3/s', 'gal/min'] },
      { key: 'head', label: 'Total Dynamic Head', defaultValue: 35, defaultUnit: 'm', units: ['m', 'ft'] },
      { key: 'density', label: 'Fluid Density (kg/m³)', defaultValue: 998, defaultUnit: '1' },
      { key: 'efficiency', label: 'Pump Efficiency (0–1)', defaultValue: 0.72, defaultUnit: '1' },
    ],
  },
  {
    id: 'gear_shaft_design',
    label: 'Gear & ASME Shaft Sizing',
    description: 'Spur gear pitch diameters, tooth tangential force, and combined bending+torque ASME shaft diameter.',
    fields: [
      { key: 'module_mm', label: 'Metric Gear Module (mm)', defaultValue: 3, defaultUnit: '1' },
      { key: 'teeth_pinion', label: 'Pinion Teeth (Z₁)', defaultValue: 20, defaultUnit: '1' },
      { key: 'teeth_gear', label: 'Gear Teeth (Z₂)', defaultValue: 60, defaultUnit: '1' },
      { key: 'torque', label: 'Shaft Torque', defaultValue: 180, defaultUnit: 'N*m', units: ['N*m', 'kN*m', 'lbf*ft'] },
      { key: 'bending_moment', label: 'Bending Moment', defaultValue: 220, defaultUnit: 'N*m', units: ['N*m', 'kN*m', 'lbf*ft'] },
      { key: 'yield_strength', label: 'Shaft Yield Strength', defaultValue: 310, defaultUnit: 'MPa', units: ['MPa', 'psi'] },
      { key: 'target_fos', label: 'Target Safety Factor', defaultValue: 2.0, defaultUnit: '1' },
    ],
  },
  {
    id: 'electrical_circuits',
    label: 'Electrical AC RLC Circuit',
    description: 'Series RLC complex impedance, current, power factor, real power, and resonant frequency f₀.',
    fields: [
      { key: 'voltage', label: 'Source RMS Voltage', defaultValue: 120, defaultUnit: 'V', units: ['V', 'kV', 'mV'] },
      { key: 'frequency', label: 'Supply Frequency', defaultValue: 60, defaultUnit: 'Hz', units: ['Hz', 'kHz'] },
      { key: 'resistance', label: 'Resistance (R)', defaultValue: 24, defaultUnit: 'ohm', units: ['ohm', 'kohm'] },
      { key: 'inductance', label: 'Inductance (L)', defaultValue: 20, defaultUnit: 'mH', units: ['mH', 'H', 'uH'] },
      { key: 'capacitance', label: 'Capacitance (C)', defaultValue: 100, defaultUnit: 'uF', units: ['uF', 'nF', 'F'] },
    ],
  },
];

function triggerBlobDownload(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function buildCalculationMarkdownReport(calc: EngineeringCalculationResponse): string {
  return [
    `# ${calc.title}`,
    '',
    '## 1. Established Assumptions & Scope',
    ...calc.assumptions.map((a) => `- ${a}`),
    '',
    '## 2. Step-by-Step Derivation',
    ...calc.steps.map((s) => `- **${s.label}**: \`${s.formula}\` -> \`${s.substitution}\` = **${s.result}**`),
    '',
    '## 3. Verified Numerical Outputs',
    '| Parameter | Value | Verification Kind |',
    '| --- | --- | --- |',
    ...calc.outputs.map((o) => `| ${o.label} | ${o.formatted} | ${o.kind} |`),
    '',
    '## 4. Independent Consistency Check',
    `- **${calc.independent_check.passed ? 'PASSED' : 'CHECK WARNING'}**: ${calc.independent_check.method} — ${calc.independent_check.detail}`,
    '',
    ...(calc.warnings.length > 0
      ? ['## 5. Sanity & Limit Warnings', ...calc.warnings.map((w) => `- [${w.severity.toUpperCase()}] ${w.message}`), '']
      : []),
    '## Safety Notice',
    `> ${calc.safety_notice}`,
  ].join('\n');
}

export const GenesisEngineeringModule: React.FC<GenesisEngineeringModuleProps> = ({ settings }) => {
  const [activeTab, setActiveTab] = useState<EngineeringTab>('calculator');
  const [status, setStatus] = useState<EngineeringStatusResponse | null>(null);
  const [disciplines, setDisciplines] = useState<DisciplineReferenceItem[]>([]);
  const [materials, setMaterials] = useState<EngineeringMaterialItem[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [pendingOverwrite, setPendingOverwrite] = useState<{
    filename: string;
    content: string;
  } | null>(null);

  // Tab 1: Engineering Calculator State
  const [selectedCalcId, setSelectedCalcId] = useState<EngineeringCalculatorId>('stress_strain');
  const [calcInputs, setCalcInputs] = useState<Record<string, { value: number; unit: string }>>(() => {
    const init: Record<string, { value: number; unit: string }> = {};
    CALCULATOR_DEFINITIONS[0].fields.forEach((f) => {
      init[f.key] = { value: f.defaultValue, unit: f.defaultUnit };
    });
    return init;
  });
  const [calcResult, setCalcResult] = useState<EngineeringCalculationResponse | null>(null);
  const [calcBusy, setCalcBusy] = useState(false);

  // Tab 2: Math & Unit Converter State
  const [unitValue, setUnitValue] = useState(100);
  const [unitFrom, setUnitFrom] = useState('psi');
  const [unitTo, setUnitTo] = useState('MPa');
  const [unitResult, setUnitResult] = useState<string | null>(null);

  const [mathOp, setMathOp] = useState<string>('ode_rk4');
  const [mathExpr, setMathExpr] = useState('-0.4 * y + sin(t)');
  const [mathVar, setMathVar] = useState('x');
  const [mathLower, setMathLower] = useState(0);
  const [mathUpper, setMathUpper] = useState(12);
  const [mathInitialY, setMathInitialY] = useState(2);
  const [matrixAText, setMatrixAText] = useState('[[4, -1, 0], [-1, 4, -1], [0, -1, 3]]');
  const [matrixBText, setMatrixBText] = useState('[15, 10, 10]');
  const [statsPointsText, setStatsPointsText] = useState('0,1.2\n1,3.1\n2,4.9\n3,7.3\n4,9.1');
  const [mathBusy, setMathBusy] = useState(false);
  const [mathResult, setMathResult] = useState<MathComputationResponse | null>(null);

  // Tab 3: Disciplines & Explainer State
  const [selectedDisciplineId, setSelectedDisciplineId] = useState<EngineeringDisciplineId>('mechanical');
  const [disciplineQuestion, setDisciplineQuestion] = useState('');
  const [disciplineExplainOutput, setDisciplineExplainOutput] = useState<string | null>(null);
  const [explainBusy, setExplainBusy] = useState(false);

  // Tab 4: Technical Design & CAD State
  const [diagramKind, setDiagramKind] = useState<EngineeringDiagramKind>('shaft_step');
  const [diagParam1, setDiagParam1] = useState(25);
  const [diagParam2, setDiagParam2] = useState(36);
  const [diagParam3, setDiagParam3] = useState(180);
  const [drawingNotes, setDrawingNotes] = useState('ASME Y14.5 third-angle, Ø25 H7/g6 bearing fit, ±0.05 mm');
  const [diagramResult, setDiagramResult] = useState<EngineeringDiagramResponse | null>(null);
  const [designBusy, setDesignBusy] = useState(false);

  // Tab 5: Scientific Experiments Lab State
  const [experiments, setExperiments] = useState<ScientificExperimentItem[]>([]);
  const [selectedExpId, setSelectedExpId] = useState<string>('');
  const [newExpTitle, setNewExpTitle] = useState('');
  const [newExpHypothesis, setNewExpHypothesis] = useState('');
  const [newExpPlan, setNewExpPlan] = useState('');
  const [obsLabel, setObsLabel] = useState('Trial 1');
  const [obsX, setObsX] = useState(1);
  const [obsTheo, setObsTheo] = useState(10.0);
  const [obsExp, setObsExp] = useState(9.75);
  const [obsUnit, setObsUnit] = useState('N');

  // Tab 6: Python Scientific Sandbox State
  const [presets, setPresets] = useState<Array<{ id: string; title: string; description: string; code: string }>>([]);
  const [simCode, setSimCode] = useState('');
  const [simApproved, setSimApproved] = useState(false);
  const [simBusy, setSimBusy] = useState(false);
  const [simResult, setSimResult] = useState<SimulationRunResponse | null>(null);

  useEffect(() => {
    Promise.all([
      apiClient.getEngineeringStatus(),
      apiClient.getEngineeringDisciplines(),
      apiClient.getSimulationPresets(),
      apiClient.listExperiments(),
    ])
      .then(([st, discData, simData, expList]) => {
        setStatus(st);
        setDisciplines(discData.disciplines);
        setMaterials(discData.materials);
        setPresets(simData.presets);
        if (simData.presets.length > 0) {
          setSimCode(simData.presets[0].code);
        }
        setExperiments(expList);
        if (expList.length > 0) {
          setSelectedExpId(expList[0].id);
        }
      })
      .catch((err) => {
        setError(err instanceof Error ? err.message : 'Failed to load Engineering workspace status.');
      });
  }, []);

  const currentCalcDef =
    CALCULATOR_DEFINITIONS.find((c) => c.id === selectedCalcId) || CALCULATOR_DEFINITIONS[0];

  const handleSelectCalculator = (id: EngineeringCalculatorId) => {
    setSelectedCalcId(id);
    setCalcResult(null);
    const def = CALCULATOR_DEFINITIONS.find((c) => c.id === id);
    if (def) {
      const next: Record<string, { value: number; unit: string }> = {};
      def.fields.forEach((f) => {
        next[f.key] = { value: f.defaultValue, unit: f.defaultUnit };
      });
      setCalcInputs(next);
    }
  };

  const handleRunCalculation = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setNotice(null);
    setCalcBusy(true);
    try {
      const res = await apiClient.runEngineeringCalculation({
        calculator: selectedCalcId,
        inputs: calcInputs,
        save_history: true,
      });
      setCalcResult(res);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Calculation failed.');
    } finally {
      setCalcBusy(false);
    }
  };

  const handleConvertUnits = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    try {
      const res = await apiClient.convertUnits({ value: unitValue, from_unit: unitFrom, to_unit: unitTo });
      setUnitResult(res.formatted);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unit conversion error.');
    }
  };

  const handleSelectMathOp = (op: string) => {
    setMathOp(op);
    setMathResult(null);
    if (op === 'evaluate') setMathExpr('sin(pi/4)^2 + cos(pi/4)^2');
    else if (op === 'derivative') setMathExpr('x^3 - 4*x + sin(x)');
    else if (op === 'integral') {
      setMathExpr('exp(-0.2*x) * cos(x)');
      setMathLower(0);
      setMathUpper(6);
    } else if (op === 'ode_rk4') {
      setMathExpr('-0.4 * y + sin(t)');
      setMathLower(0);
      setMathUpper(12);
      setMathInitialY(2);
    } else if (op === 'root_find') {
      setMathExpr('x^3 - 2*x - 5');
      setMathLower(1);
      setMathUpper(3);
    }
  };

  const handleRunMath = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setMathBusy(true);
    try {
      let params: Record<string, unknown> = {};
      if (mathOp === 'evaluate') {
        params = { expression: mathExpr, plot_var: 'x', x_min: mathLower, x_max: mathUpper };
      } else if (mathOp === 'derivative') {
        params = { expression: mathExpr, variable: mathVar, at: mathLower };
      } else if (mathOp === 'integral') {
        params = { expression: mathExpr, variable: mathVar, lower: mathLower, upper: mathUpper };
      } else if (mathOp === 'ode_rk4') {
        params = { rhs: mathExpr, t0: mathLower, t_end: mathUpper, y0: mathInitialY, steps: 100 };
      } else if (mathOp === 'root_find') {
        params = { expression: mathExpr, variable: mathVar, x_low: mathLower, x_high: mathUpper };
      } else if (mathOp === 'matrix_solve' || mathOp === 'matrix_analyze') {
        params = {
          A: JSON.parse(matrixAText),
          ...(mathOp === 'matrix_solve' ? { b: JSON.parse(matrixBText) } : {}),
        };
      } else if (mathOp === 'statistics_regression') {
        const pts = statsPointsText
          .split('\n')
          .map((line) => line.trim().split(',').map(Number))
          .filter((pair) => pair.length === 2 && Number.isFinite(pair[0]) && Number.isFinite(pair[1]))
          .map(([x, y]) => ({ x, y }));
        params = { points: pts };
      }
      const res = await apiClient.runMathOperation({ operation: mathOp, params });
      setMathResult(res);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Math computation failed.');
    } finally {
      setMathBusy(false);
    }
  };

  const handleExplainDiscipline = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!disciplineQuestion.trim()) return;
    setError(null);
    setExplainBusy(true);
    try {
      const res = await apiClient.explainDiscipline({
        discipline_id: selectedDisciplineId,
        question: disciplineQuestion,
        model_id: settings?.active_model_id || null,
      });
      setDisciplineExplainOutput(res.explanation);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Explanation request failed.');
    } finally {
      setExplainBusy(false);
    }
  };

  const handleGenerateDiagram = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setDesignBusy(true);
    try {
      const params: Record<string, unknown> =
        diagramKind === 'beam_load'
          ? { span_m: diagParam1, load_kn: diagParam2, depth_mm: diagParam3 }
          : diagramKind === 'shaft_step'
            ? { d_journal_mm: diagParam1, d_shoulder_mm: diagParam2, length_mm: diagParam3 }
            : diagramKind === 'pressure_vessel'
              ? { inner_diameter_mm: diagParam1, wall_mm: diagParam2, pressure_bar: diagParam3 }
              : diagramKind === 'rlc_circuit'
                ? { resistance_ohm: diagParam1, inductance_mh: diagParam2, capacitance_uf: diagParam3 }
                : { pipe_mm: diagParam1, flow_ls: diagParam2, head_m: diagParam3 };

      const res = await apiClient.generateEngineeringDiagram({
        kind: diagramKind,
        params,
        drawing_notes: drawingNotes,
      });
      setDiagramResult(res);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Diagram generation failed.');
    } finally {
      setDesignBusy(false);
    }
  };

  const handleCreateExperiment = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newExpTitle.trim()) return;
    setError(null);
    try {
      const created = await apiClient.createExperiment({
        title: newExpTitle.trim(),
        discipline: selectedDisciplineId,
        established_facts: ['Conservation of energy & Newton’s 2nd law govern macroscopic mechanics.'],
        assumptions: ['Ambient lab temperature ~22 °C; calibrated sensor baseline.'],
        hypothesis: newExpHypothesis.trim() || 'Measured values agree with linear theoretical model within ±5%.',
        experimental_plan: newExpPlan.trim() || 'Record independent trials across load steps and compute RMSE.',
        observations: [],
        sources: [{ title: 'Step 11 Engineering Formula Reference', reference: 'genesis://engineering', reliability: 'established_standard' }],
      });
      setExperiments((prev) => [created, ...prev]);
      setSelectedExpId(created.id);
      setNewExpTitle('');
      setNewExpHypothesis('');
      setNewExpPlan('');
      setNotice(`Created experiment "${created.title}".`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create experiment.');
    }
  };

  const activeExperiment = experiments.find((ex) => ex.id === selectedExpId) || null;

  const handleAddObservation = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!activeExperiment) return;
    setError(null);
    const nextObs = [
      ...activeExperiment.observations,
      {
        id: `obs-${Date.now()}`,
        label: obsLabel.trim() || `Trial ${activeExperiment.observations.length + 1}`,
        x_value: obsX,
        theoretical_value: obsTheo,
        experimental_value: obsExp,
        unit: obsUnit || 'units',
      },
    ];
    try {
      const updated = await apiClient.updateExperiment(activeExperiment.id, { observations: nextObs });
      setExperiments((prev) => prev.map((x) => (x.id === updated.id ? updated : x)));
      setObsLabel(`Trial ${nextObs.length + 1}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to add observation.');
    }
  };

  const handleRunSimulation = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setSimBusy(true);
    try {
      const res = await apiClient.runEngineeringSimulation({
        code: simCode,
        approved: simApproved,
        timeout_ms: 4000,
      });
      setSimResult(res);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Simulation failed or blocked.');
    } finally {
      setSimBusy(false);
    }
  };

  const handleExportReport = async (title: string, md: string, format: 'pdf' | 'docx' | 'md') => {
    setError(null);
    try {
      const { blob, filename } = await apiClient.exportEngineeringReport({
        title,
        format,
        markdown_content: md,
      });
      triggerBlobDownload(blob, filename);
      setNotice(`Exported ${filename} (${format.toUpperCase()}).`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Report export failed.');
    }
  };

  const handleSaveToCreator = async (filename: string, content: string, overwrite = false) => {
    setError(null);
    setNotice(null);
    try {
      const res = await apiClient.saveEngineeringToCreator({
        filename,
        content,
        overwrite,
        summary: 'Engineering & Scientific report from Step 11',
      });
      setPendingOverwrite(null);
      setNotice(`Saved "${res.file.filename}" to Creator Studio project "${res.project_name}".`);
    } catch (err) {
      if (err instanceof ApiRequestError && err.code === 'OVERWRITE_CONFIRMATION_REQUIRED') {
        setPendingOverwrite({ filename: err.existingName || filename, content });
        return;
      }
      setError(err instanceof Error ? err.message : 'Failed to save to Creator Studio.');
    }
  };

  const activeDiscipline =
    disciplines.find((d) => d.id === selectedDisciplineId) || disciplines[0] || null;

  return (
    <div className="h-full overflow-y-auto px-4 lg:px-8 py-6">
      <div className="max-w-6xl mx-auto space-y-6">
        {/* Header */}
        <div className="flex flex-wrap items-center justify-between gap-4 pb-5 border-b border-white/[0.08]">
          <div>
            <h2 className="font-display text-xl font-semibold text-slate-100">
              Genesis Engineering & Scientific Intelligence
            </h2>
            <p className="text-sm text-slate-400 mt-1">
              Validated physical calculators, MathJS symbolic/numerical analysis, SVG engineering diagrams, scientific experiments, and sandboxed Python computing.
            </p>
          </div>
          {status && (
            <div className="flex flex-wrap items-center gap-2 text-xs text-slate-300">
              <span className="px-2.5 py-1 rounded bg-[#11161F] border border-white/[0.08]">
                Calculators: <strong className="text-blue-300">{status.calculators.length}</strong>
              </span>
              <span className="px-2.5 py-1 rounded bg-[#11161F] border border-white/[0.08]">
                Python:{' '}
                <strong className={status.simulation_tools[0]?.available ? 'text-emerald-400' : 'text-amber-300'}>
                  {status.simulation_tools[0]?.version || 'Unavailable'}
                </strong>
              </span>
            </div>
          )}
        </div>

        {/* Navigation Sub-tabs */}
        <div className="flex flex-wrap items-center gap-2">
          {[
            { id: 'calculator' as const, label: 'Engineering Calculator', icon: Calculator },
            { id: 'math' as const, label: 'Mathematics & Plotting', icon: Sigma },
            { id: 'disciplines' as const, label: 'Engineering Disciplines', icon: BookOpen },
            { id: 'design' as const, label: 'Technical Design & CAD', icon: Ruler },
            { id: 'experiments' as const, label: 'Scientific Research Lab', icon: FlaskConical },
            { id: 'simulation' as const, label: 'Python Scientific Sandbox', icon: Compass },
          ].map((tab) => {
            const Icon = tab.icon;
            const active = activeTab === tab.id;
            return (
              <button
                key={tab.id}
                type="button"
                onClick={() => setActiveTab(tab.id)}
                className={`inline-flex items-center gap-2 px-3.5 py-2 rounded-lg text-xs font-medium border transition-colors cursor-pointer ${
                  active
                    ? 'bg-blue-600 border-blue-500 text-white'
                    : 'bg-[#11161F] border-white/[0.08] text-slate-300 hover:bg-[#18202D]'
                }`}
              >
                <Icon className="w-3.5 h-3.5" />
                <span>{tab.label}</span>
              </button>
            );
          })}
        </div>

        {error && (
          <div className="p-3.5 rounded-lg bg-red-500/10 border border-red-500/25 text-xs text-red-300 flex items-center gap-2">
            <AlertTriangle className="w-4 h-4 text-red-400 shrink-0" />
            <span>{error}</span>
          </div>
        )}
        {notice && (
          <div className="p-3.5 rounded-lg bg-emerald-500/10 border border-emerald-500/25 text-xs text-emerald-300 flex items-center gap-2">
            <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0" />
            <span>{notice}</span>
          </div>
        )}
        {pendingOverwrite && (
          <div className="p-4 rounded-lg bg-amber-500/10 border border-amber-500/30 text-xs text-amber-200 flex flex-wrap items-center justify-between gap-3">
            <span>
              Creator file <strong>{pendingOverwrite.filename}</strong> already exists. Confirm saving a new versioned revision?
            </span>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => void handleSaveToCreator(pendingOverwrite.filename, pendingOverwrite.content, true)}
                className="px-3 py-1.5 rounded bg-amber-500/20 border border-amber-400/40 text-amber-100 font-medium cursor-pointer"
              >
                Confirm New Revision
              </button>
              <button
                type="button"
                onClick={() => setPendingOverwrite(null)}
                className="px-3 py-1.5 rounded bg-[#161C26] border border-white/[0.1] text-slate-300 cursor-pointer"
              >
                Cancel
              </button>
            </div>
          </div>
        )}

        {/* TAB 1: ENGINEERING CALCULATOR */}
        {activeTab === 'calculator' && (
          <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
            <div className="lg:col-span-4 space-y-2">
              {CALCULATOR_DEFINITIONS.map((c) => (
                <button
                  key={c.id}
                  type="button"
                  onClick={() => handleSelectCalculator(c.id)}
                  className={`w-full text-left p-3.5 rounded-xl border transition-colors cursor-pointer ${
                    selectedCalcId === c.id
                      ? 'bg-[#141B26] border-blue-500/50'
                      : 'bg-[#11161F] border-white/[0.08] hover:border-white/[0.16]'
                  }`}
                >
                  <div className="text-xs font-semibold text-slate-100">{c.label}</div>
                  <div className="text-[11px] text-slate-400 mt-1 leading-relaxed">{c.description}</div>
                </button>
              ))}
            </div>

            <div className="lg:col-span-8 space-y-6">
              <form
                onSubmit={handleRunCalculation}
                className="rounded-xl border border-white/[0.08] bg-[#11161F] p-6 space-y-4"
              >
                <div className="flex items-center justify-between gap-3">
                  <h3 className="font-display text-base font-semibold text-slate-100">
                    {currentCalcDef.label}
                  </h3>
                  <button
                    type="submit"
                    disabled={calcBusy}
                    className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-xs font-medium text-white cursor-pointer"
                  >
                    {calcBusy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Play className="w-3.5 h-3.5" />}
                    <span>Compute & Verify</span>
                  </button>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  {currentCalcDef.fields.map((f) => {
                    const entry = calcInputs[f.key] || { value: f.defaultValue, unit: f.defaultUnit };
                    return (
                      <div key={f.key} className="space-y-1.5">
                        <label className="block text-xs text-slate-300">{f.label}</label>
                        <div className="flex gap-2">
                          <input
                            type="number"
                            step="any"
                            value={entry.value}
                            onChange={(e) =>
                              setCalcInputs((prev) => ({
                                ...prev,
                                [f.key]: { ...entry, value: Number(e.target.value) },
                              }))
                            }
                            className="flex-1 min-w-0 px-3 py-2 rounded-lg bg-[#0C1017] border border-white/[0.1] text-xs text-slate-100 font-mono"
                          />
                          {f.units ? (
                            <select
                              value={entry.unit}
                              onChange={(e) =>
                                setCalcInputs((prev) => ({
                                  ...prev,
                                  [f.key]: { ...entry, unit: e.target.value },
                                }))
                              }
                              className="w-24 px-2 py-2 rounded-lg bg-[#0C1017] border border-white/[0.1] text-xs text-slate-200 font-mono"
                            >
                              {f.units.map((u) => (
                                <option key={u} value={u}>
                                  {u}
                                </option>
                              ))}
                            </select>
                          ) : (
                            <span className="px-2.5 py-2 rounded-lg bg-[#0C1017] border border-white/[0.06] text-xs text-slate-400 font-mono">
                              {f.defaultUnit === '1' ? 'ratio' : f.defaultUnit}
                            </span>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </form>

              {calcResult && (
                <div className="rounded-xl border border-white/[0.08] bg-[#11161F] p-6 space-y-5">
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <h4 className="font-display text-sm font-semibold text-slate-100">{calcResult.title}</h4>
                    <span
                      className={`px-2.5 py-1 rounded text-[11px] font-medium border ${
                        calcResult.independent_check.passed
                          ? 'bg-emerald-500/10 border-emerald-500/30 text-emerald-300'
                          : 'bg-amber-500/10 border-amber-500/30 text-amber-300'
                      }`}
                    >
                      Cross-Check: {calcResult.independent_check.passed ? 'PASSED' : 'REVIEW'}
                    </span>
                  </div>

                  {/* Outputs Grid */}
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    {calcResult.outputs.map((out) => (
                      <div key={out.key} className="p-3.5 rounded-lg bg-[#0C1017] border border-white/[0.06]">
                        <div className="text-[11px] text-slate-400">{out.label}</div>
                        <div className="text-sm font-mono font-semibold text-blue-300 mt-1">{out.formatted}</div>
                        <div className="text-[10px] text-slate-500 mt-1">
                          Method: {out.kind.replace(/_/g, ' ')} {out.reference_note ? `· ${out.reference_note}` : ''}
                        </div>
                      </div>
                    ))}
                  </div>

                  {/* Warnings */}
                  {calcResult.warnings.length > 0 && (
                    <div className="space-y-2">
                      {calcResult.warnings.map((w, idx) => (
                        <div
                          key={`${w.code}-${idx}`}
                          className={`p-3 rounded-lg text-xs border flex items-start gap-2 ${
                            w.severity === 'critical'
                              ? 'bg-red-500/10 border-red-500/30 text-red-200'
                              : w.severity === 'warning'
                                ? 'bg-amber-500/10 border-amber-500/30 text-amber-200'
                                : 'bg-blue-500/10 border-blue-500/25 text-blue-200'
                          }`}
                        >
                          <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
                          <span>{w.message}</span>
                        </div>
                      ))}
                    </div>
                  )}

                  {/* Steps & Independent Check */}
                  <div className="space-y-2">
                    <div className="text-xs font-medium text-slate-300">Calculation Trace & Consistency Check</div>
                    <div className="p-3.5 rounded-lg bg-[#0C1017] border border-white/[0.06] space-y-2 text-xs">
                      {calcResult.steps.map((s, idx) => (
                        <div key={idx} className="flex flex-wrap justify-between gap-2 border-b border-white/[0.04] pb-1.5 last:border-0 last:pb-0">
                          <span className="text-slate-300">{s.label}</span>
                          <span className="font-mono text-slate-400">
                            {s.formula} | {s.substitution} → <strong className="text-slate-100">{s.result}</strong>
                          </span>
                        </div>
                      ))}
                      <div className="pt-2 text-[11px] text-emerald-300">
                        {calcResult.independent_check.method}: {calcResult.independent_check.detail}
                      </div>
                    </div>
                  </div>

                  {/* Assumptions & Disclaimer */}
                  <div className="p-3.5 rounded-lg bg-amber-500/5 border border-amber-500/20 text-[11px] text-slate-300 space-y-1.5">
                    <div className="font-semibold text-amber-300 flex items-center gap-1.5">
                      <ShieldAlert className="w-3.5 h-3.5" />
                      <span>Assumptions, Limitations & Safety Boundary</span>
                    </div>
                    <ul className="list-disc pl-4 space-y-0.5 text-slate-400">
                      {calcResult.assumptions.map((a, i) => (
                        <li key={i}>{a}</li>
                      ))}
                    </ul>
                    <p className="text-amber-200/90 pt-1">{calcResult.safety_notice}</p>
                  </div>

                  {/* Export & Integration Actions */}
                  <div className="flex flex-wrap items-center gap-2 pt-2 border-t border-white/[0.06]">
                    {(['pdf', 'docx', 'md'] as const).map((fmt) => (
                      <button
                        key={fmt}
                        type="button"
                        onClick={() =>
                          void handleExportReport(calcResult.title, buildCalculationMarkdownReport(calcResult), fmt)
                        }
                        className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-[#161C26] hover:bg-[#1E2634] border border-white/[0.1] text-xs text-slate-200 cursor-pointer"
                      >
                        <Download className="w-3.5 h-3.5" />
                        <span>Export .{fmt.toUpperCase()}</span>
                      </button>
                    ))}
                    <button
                      type="button"
                      onClick={() =>
                        void handleSaveToCreator(
                          `${calcResult.calculator}_report.md`,
                          buildCalculationMarkdownReport(calcResult)
                        )
                      }
                      className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-[#161C26] hover:bg-[#1E2634] border border-white/[0.1] text-xs text-slate-200 cursor-pointer"
                    >
                      <Layers className="w-3.5 h-3.5 text-blue-400" />
                      <span>Save to Creator</span>
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        void apiClient
                          .saveEngineeringToMemory({
                            title: calcResult.title,
                            content: calcResult.outputs.map((o) => `${o.label}: ${o.formatted}`).join('; '),
                            tags: ['engineering', calcResult.calculator],
                            approved: true,
                          })
                          .then(() => setNotice('Saved engineering calculation outputs to Memory.'))
                          .catch((e) => setError(e instanceof Error ? e.message : 'Memory save failed.'));
                      }}
                      className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-[#161C26] hover:bg-[#1E2634] border border-white/[0.1] text-xs text-slate-200 cursor-pointer"
                    >
                      <Database className="w-3.5 h-3.5 text-emerald-400" />
                      <span>Approve &rarr; Memory</span>
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        void apiClient
                          .dispatchEngineeringAgent({
                            goal: `Review and cross-check ${calcResult.title}`,
                            report_summary: buildCalculationMarkdownReport(calcResult),
                          })
                          .then(() => setNotice('Created Agent OS review task for this calculation.'))
                          .catch((e) => setError(e instanceof Error ? e.message : 'Agent dispatch failed.'));
                      }}
                      className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-[#161C26] hover:bg-[#1E2634] border border-white/[0.1] text-xs text-slate-200 cursor-pointer"
                    >
                      <Bot className="w-3.5 h-3.5 text-amber-400" />
                      <span>Dispatch Agent Review</span>
                    </button>
                  </div>
                </div>
              )}
            </div>
          </div>
        )}

        {/* TAB 2: MATHEMATICS & PLOTTING */}
        {activeTab === 'math' && (
          <div className="space-y-6">
            {/* Quick Unit Converter Bar */}
            <form
              onSubmit={handleConvertUnits}
              className="rounded-xl border border-white/[0.08] bg-[#11161F] p-5 flex flex-wrap items-end gap-3"
            >
              <div>
                <label className="block text-[11px] text-slate-400 mb-1">Value</label>
                <input
                  type="number"
                  step="any"
                  value={unitValue}
                  onChange={(e) => setUnitValue(Number(e.target.value))}
                  className="w-28 px-3 py-2 rounded-lg bg-[#0C1017] border border-white/[0.1] text-xs text-slate-100 font-mono"
                />
              </div>
              <div>
                <label className="block text-[11px] text-slate-400 mb-1">From Unit</label>
                <input
                  type="text"
                  value={unitFrom}
                  onChange={(e) => setUnitFrom(e.target.value)}
                  className="w-28 px-3 py-2 rounded-lg bg-[#0C1017] border border-white/[0.1] text-xs text-slate-100 font-mono"
                />
              </div>
              <div>
                <label className="block text-[11px] text-slate-400 mb-1">To Unit</label>
                <input
                  type="text"
                  value={unitTo}
                  onChange={(e) => setUnitTo(e.target.value)}
                  className="w-28 px-3 py-2 rounded-lg bg-[#0C1017] border border-white/[0.1] text-xs text-slate-100 font-mono"
                />
              </div>
              <button
                type="submit"
                className="px-4 py-2 rounded-lg bg-blue-600 hover:bg-blue-500 text-xs font-medium text-white cursor-pointer"
              >
                Convert Units
              </button>
              {unitResult && (
                <div className="px-3 py-2 rounded-lg bg-emerald-500/10 border border-emerald-500/25 text-xs font-mono text-emerald-300">
                  {unitValue} {unitFrom} = <strong>{unitResult}</strong>
                </div>
              )}
            </form>

            {/* Mathematical Computation Panel */}
            <form
              onSubmit={handleRunMath}
              className="rounded-xl border border-white/[0.08] bg-[#11161F] p-6 space-y-4"
            >
              <div className="flex flex-wrap items-center justify-between gap-3">
                <h3 className="font-display text-base font-semibold text-slate-100">
                  MathJS Symbolic & Numerical Solver
                </h3>
                <select
                  value={mathOp}
                  onChange={(e) => handleSelectMathOp(e.target.value)}
                  className="px-3 py-2 rounded-lg bg-[#0C1017] border border-white/[0.1] text-xs text-slate-100"
                >
                  <option value="evaluate">Algebra / Function Evaluation & Plot</option>
                  <option value="derivative">Symbolic Derivative + Finite Diff Check</option>
                  <option value="integral">Definite Integral (Simpson Richardson)</option>
                  <option value="ode_rk4">Differential Equation IVP (RK4 dy/dt)</option>
                  <option value="root_find">Root Finding (Bisection + Newton)</option>
                  <option value="matrix_solve">Linear System Solve (A·x = b)</option>
                  <option value="matrix_analyze">Matrix Det, Inverse & Eigenvalues</option>
                  <option value="statistics_regression">Statistics & Linear Regression</option>
                </select>
              </div>

              {['evaluate', 'derivative', 'integral', 'ode_rk4', 'root_find'].includes(mathOp) && (
                <div className="grid grid-cols-1 sm:grid-cols-4 gap-3">
                  <div className="sm:col-span-2">
                    <label className="block text-[11px] text-slate-400 mb-1">
                      {mathOp === 'ode_rk4' ? 'dy/dt = f(t, y)' : 'Expression f(x)'}
                    </label>
                    <input
                      type="text"
                      value={mathExpr}
                      onChange={(e) => setMathExpr(e.target.value)}
                      className="w-full px-3 py-2 rounded-lg bg-[#0C1017] border border-white/[0.1] text-xs text-slate-100 font-mono"
                    />
                  </div>
                  <div>
                    <label className="block text-[11px] text-slate-400 mb-1">
                      {mathOp === 'derivative' ? 'Eval at x' : 'Start / Low Bound'}
                    </label>
                    <input
                      type="number"
                      step="any"
                      value={mathLower}
                      onChange={(e) => setMathLower(Number(e.target.value))}
                      className="w-full px-3 py-2 rounded-lg bg-[#0C1017] border border-white/[0.1] text-xs text-slate-100 font-mono"
                    />
                  </div>
                  <div>
                    <label className="block text-[11px] text-slate-400 mb-1">
                      {mathOp === 'ode_rk4' ? 't_end ( & y₀ below )' : mathOp === 'derivative' ? 'Variable' : 'Upper Bound'}
                    </label>
                    {mathOp === 'derivative' ? (
                      <input
                        type="text"
                        value={mathVar}
                        onChange={(e) => setMathVar(e.target.value)}
                        className="w-full px-3 py-2 rounded-lg bg-[#0C1017] border border-white/[0.1] text-xs text-slate-100 font-mono"
                      />
                    ) : (
                      <input
                        type="number"
                        step="any"
                        value={mathUpper}
                        onChange={(e) => setMathUpper(Number(e.target.value))}
                        className="w-full px-3 py-2 rounded-lg bg-[#0C1017] border border-white/[0.1] text-xs text-slate-100 font-mono"
                      />
                    )}
                  </div>
                  {mathOp === 'ode_rk4' && (
                    <div>
                      <label className="block text-[11px] text-slate-400 mb-1">Initial y(t₀)</label>
                      <input
                        type="number"
                        step="any"
                        value={mathInitialY}
                        onChange={(e) => setMathInitialY(Number(e.target.value))}
                        className="w-full px-3 py-2 rounded-lg bg-[#0C1017] border border-white/[0.1] text-xs text-slate-100 font-mono"
                      />
                    </div>
                  )}
                </div>
              )}

              {(mathOp === 'matrix_solve' || mathOp === 'matrix_analyze') && (
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <div>
                    <label className="block text-[11px] text-slate-400 mb-1">Matrix A (JSON array)</label>
                    <textarea
                      rows={3}
                      value={matrixAText}
                      onChange={(e) => setMatrixAText(e.target.value)}
                      className="w-full px-3 py-2 rounded-lg bg-[#0C1017] border border-white/[0.1] text-xs text-slate-100 font-mono"
                    />
                  </div>
                  {mathOp === 'matrix_solve' && (
                    <div>
                      <label className="block text-[11px] text-slate-400 mb-1">Vector b (JSON array)</label>
                      <textarea
                        rows={3}
                        value={matrixBText}
                        onChange={(e) => setMatrixBText(e.target.value)}
                        className="w-full px-3 py-2 rounded-lg bg-[#0C1017] border border-white/[0.1] text-xs text-slate-100 font-mono"
                      />
                    </div>
                  )}
                </div>
              )}

              {mathOp === 'statistics_regression' && (
                <div>
                  <label className="block text-[11px] text-slate-400 mb-1">Data Points (one "x,y" per line)</label>
                  <textarea
                    rows={4}
                    value={statsPointsText}
                    onChange={(e) => setStatsPointsText(e.target.value)}
                    className="w-full px-3 py-2 rounded-lg bg-[#0C1017] border border-white/[0.1] text-xs text-slate-100 font-mono"
                  />
                </div>
              )}

              <button
                type="submit"
                disabled={mathBusy}
                className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg bg-blue-600 hover:bg-blue-500 text-xs font-medium text-white cursor-pointer"
              >
                {mathBusy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Play className="w-3.5 h-3.5" />}
                <span>Compute & Plot</span>
              </button>

              {mathResult && (
                <div className="space-y-4 pt-3 border-t border-white/[0.06]">
                  <div className="p-3.5 rounded-lg bg-[#0C1017] border border-white/[0.06] space-y-2">
                    <div className="text-xs font-semibold text-blue-300">{mathResult.summary}</div>
                    <ul className="space-y-1 text-xs text-slate-300 font-mono">
                      {mathResult.steps.map((s, i) => (
                        <li key={i}>• {s}</li>
                      ))}
                    </ul>
                    {mathResult.verification && (
                      <div className="text-[11px] text-emerald-300 pt-1">
                        {mathResult.verification.method}: {mathResult.verification.detail}
                      </div>
                    )}
                  </div>
                  {mathResult.chart && <EngineeringChartSvg chart={mathResult.chart} />}
                </div>
              )}
            </form>
          </div>
        )}

        {/* TAB 3: DISCIPLINES & MATERIALS */}
        {activeTab === 'disciplines' && (
          <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
            <div className="lg:col-span-4 space-y-2">
              {disciplines.map((d) => (
                <button
                  key={d.id}
                  type="button"
                  onClick={() => {
                    setSelectedDisciplineId(d.id);
                    setDisciplineExplainOutput(null);
                  }}
                  className={`w-full text-left p-3.5 rounded-xl border cursor-pointer ${
                    selectedDisciplineId === d.id
                      ? 'bg-[#141B26] border-blue-500/50'
                      : 'bg-[#11161F] border-white/[0.08] hover:border-white/[0.16]'
                  }`}
                >
                  <div className="text-xs font-semibold text-slate-100">{d.name}</div>
                  <div className="text-[11px] text-slate-400 mt-1 line-clamp-2">{d.overview}</div>
                </button>
              ))}
            </div>

            <div className="lg:col-span-8 space-y-6">
              {activeDiscipline && (
                <div className="rounded-xl border border-white/[0.08] bg-[#11161F] p-6 space-y-4">
                  <h3 className="font-display text-base font-semibold text-slate-100">{activeDiscipline.name}</h3>
                  <p className="text-xs text-slate-300 leading-relaxed">{activeDiscipline.overview}</p>

                  <div className="space-y-2">
                    <div className="text-xs font-medium text-slate-300">Key Engineering Formulas</div>
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
                      {activeDiscipline.key_formulas.map((f) => (
                        <div key={f.name} className="p-3 rounded-lg bg-[#0C1017] border border-white/[0.06]">
                          <div className="text-[11px] font-medium text-blue-300">{f.name}</div>
                          <div className="text-xs font-mono text-slate-100 mt-1">{f.equation}</div>
                          <div className="text-[10px] text-slate-400 mt-1">{f.variables}</div>
                        </div>
                      ))}
                    </div>
                  </div>

                  <div className="p-4 rounded-lg bg-[#0C1017] border border-white/[0.06] space-y-1.5 text-xs">
                    <div className="font-semibold text-emerald-300">Worked Example</div>
                    <div className="text-slate-200">{activeDiscipline.worked_example.problem}</div>
                    <div className="text-slate-400 font-mono text-[11px] pt-1">
                      Given: {activeDiscipline.worked_example.given.join(' · ')}
                    </div>
                    <ul className="list-disc pl-4 space-y-0.5 text-slate-300 font-mono text-[11px]">
                      {activeDiscipline.worked_example.steps.map((s, idx) => (
                        <li key={idx}>{s}</li>
                      ))}
                    </ul>
                    <div className="text-blue-300 font-medium pt-1">Answer: {activeDiscipline.worked_example.answer}</div>
                  </div>

                  <form onSubmit={handleExplainDiscipline} className="space-y-2 pt-2 border-t border-white/[0.06]">
                    <label className="block text-xs text-slate-300">
                      Ask Genesis Intelligence (Memory + KB Grounded Reference)
                    </label>
                    <div className="flex gap-2">
                      <input
                        type="text"
                        value={disciplineQuestion}
                        onChange={(e) => setDisciplineQuestion(e.target.value)}
                        placeholder={`Ask a technical ${activeDiscipline.name} question...`}
                        className="flex-1 px-3 py-2 rounded-lg bg-[#0C1017] border border-white/[0.1] text-xs text-slate-100"
                      />
                      <button
                        type="submit"
                        disabled={explainBusy}
                        className="px-4 py-2 rounded-lg bg-blue-600 hover:bg-blue-500 text-xs font-medium text-white cursor-pointer"
                      >
                        {explainBusy ? 'Explaining...' : 'Explain'}
                      </button>
                    </div>
                  </form>

                  {disciplineExplainOutput && (
                    <pre className="p-4 rounded-lg bg-[#0C1017] border border-white/[0.06] text-xs text-slate-200 whitespace-pre-wrap font-sans leading-relaxed">
                      {disciplineExplainOutput}
                    </pre>
                  )}
                </div>
              )}

              {/* Engineering Material Properties Reference Table */}
              <div className="rounded-xl border border-white/[0.08] bg-[#11161F] p-6 space-y-3">
                <h4 className="font-display text-sm font-semibold text-slate-100">
                  Reference Engineering Materials Catalog
                </h4>
                <div className="overflow-x-auto">
                  <table className="w-full text-left text-xs">
                    <thead>
                      <tr className="border-b border-white/[0.08] text-slate-400">
                        <th className="py-2 pr-3">Material</th>
                        <th className="py-2 pr-3">Density (kg/m³)</th>
                        <th className="py-2 pr-3">E (GPa)</th>
                        <th className="py-2 pr-3">Yield (MPa)</th>
                        <th className="py-2">UTS (MPa)</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-white/[0.04] font-mono text-[11px]">
                      {materials.map((m) => (
                        <tr key={m.id}>
                          <td className="py-2 pr-3 font-sans text-slate-200">{m.name}</td>
                          <td className="py-2 pr-3 text-slate-300">{m.density_kg_m3}</td>
                          <td className="py-2 pr-3 text-slate-300">{m.youngs_modulus_gpa}</td>
                          <td className="py-2 pr-3 text-blue-300">{m.yield_strength_mpa}</td>
                          <td className="py-2 text-slate-300">{m.ultimate_strength_mpa}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* TAB 4: TECHNICAL DESIGN & CAD ASSISTANCE */}
        {activeTab === 'design' && (
          <div className="space-y-6">
            <form
              onSubmit={handleGenerateDiagram}
              className="rounded-xl border border-white/[0.08] bg-[#11161F] p-6 space-y-4"
            >
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <h3 className="font-display text-base font-semibold text-slate-100">
                    2D Engineering Diagram & CAD Workflow Assistant
                  </h3>
                  <p className="text-xs text-slate-400 mt-0.5">
                    Generates dimension-annotated SVG schematics, GD&T fit guidance, and drawing note interpretation.
                  </p>
                </div>
                <select
                  value={diagramKind}
                  onChange={(e) => setDiagramKind(e.target.value as EngineeringDiagramKind)}
                  className="px-3 py-2 rounded-lg bg-[#0C1017] border border-white/[0.1] text-xs text-slate-100"
                >
                  <option value="shaft_step">Stepped Transmission Shaft</option>
                  <option value="beam_load">Simply Supported Beam</option>
                  <option value="pressure_vessel">Cylindrical Pressure Vessel</option>
                  <option value="rlc_circuit">Series RLC Electrical Schematic</option>
                  <option value="pipe_system">Pump & Process Piping P&ID</option>
                </select>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                <div>
                  <label className="block text-[11px] text-slate-400 mb-1">Primary Dimension / Value 1</label>
                  <input
                    type="number"
                    step="any"
                    value={diagParam1}
                    onChange={(e) => setDiagParam1(Number(e.target.value))}
                    className="w-full px-3 py-2 rounded-lg bg-[#0C1017] border border-white/[0.1] text-xs text-slate-100 font-mono"
                  />
                </div>
                <div>
                  <label className="block text-[11px] text-slate-400 mb-1">Secondary Parameter / Value 2</label>
                  <input
                    type="number"
                    step="any"
                    value={diagParam2}
                    onChange={(e) => setDiagParam2(Number(e.target.value))}
                    className="w-full px-3 py-2 rounded-lg bg-[#0C1017] border border-white/[0.1] text-xs text-slate-100 font-mono"
                  />
                </div>
                <div>
                  <label className="block text-[11px] text-slate-400 mb-1">Span / Pressure / Capacitance 3</label>
                  <input
                    type="number"
                    step="any"
                    value={diagParam3}
                    onChange={(e) => setDiagParam3(Number(e.target.value))}
                    className="w-full px-3 py-2 rounded-lg bg-[#0C1017] border border-white/[0.1] text-xs text-slate-100 font-mono"
                  />
                </div>
              </div>

              <div>
                <label className="block text-[11px] text-slate-400 mb-1">
                  Drawing Callouts / Multimodal OCR Notes to Interpret
                </label>
                <input
                  type="text"
                  value={drawingNotes}
                  onChange={(e) => setDrawingNotes(e.target.value)}
                  className="w-full px-3 py-2 rounded-lg bg-[#0C1017] border border-white/[0.1] text-xs text-slate-100 font-mono"
                />
              </div>

              <button
                type="submit"
                disabled={designBusy}
                className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg bg-blue-600 hover:bg-blue-500 text-xs font-medium text-white cursor-pointer"
              >
                {designBusy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Ruler className="w-3.5 h-3.5" />}
                <span>Generate Schematic & Interpret Notes</span>
              </button>
            </form>

            {diagramResult && (
              <div className="rounded-xl border border-white/[0.08] bg-[#11161F] p-6 space-y-5">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <h4 className="font-display text-sm font-semibold text-slate-100">{diagramResult.title}</h4>
                  <button
                    type="button"
                    onClick={() => {
                      void apiClient
                        .exportEngineeringReport({
                          title: diagramResult.title,
                          format: 'svg',
                          svg_content: diagramResult.svg,
                        })
                        .then(({ blob, filename }) => triggerBlobDownload(blob, filename))
                        .catch((err) => setError(err instanceof Error ? err.message : 'SVG export failed.'));
                    }}
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-[#161C26] hover:bg-[#1E2634] border border-white/[0.1] text-xs text-slate-200 cursor-pointer"
                  >
                    <Download className="w-3.5 h-3.5" />
                    <span>Export .SVG Blueprint</span>
                  </button>
                </div>

                {/* Safe scriptless SVG preview via data URL inside <img> */}
                <div className="rounded-xl border border-white/[0.08] bg-[#0B1018] p-3 flex justify-center">
                  <img
                    src={`data:image/svg+xml;charset=utf-8,${encodeURIComponent(diagramResult.svg)}`}
                    alt={diagramResult.title}
                    className="w-full max-w-[640px] h-auto rounded"
                  />
                </div>

                <div className="grid grid-cols-1 md:grid-cols-2 gap-4 text-xs">
                  <div className="p-4 rounded-lg bg-[#0C1017] border border-white/[0.06] space-y-2">
                    <div className="font-semibold text-blue-300">Dimensions & Tolerances</div>
                    {diagramResult.dimensions.map((dim) => (
                      <div key={dim.callout} className="flex justify-between gap-2 text-slate-300">
                        <span>{dim.callout}</span>
                        <span className="font-mono text-slate-100">
                          {dim.value} {dim.tolerance ? `(${dim.tolerance})` : ''}
                        </span>
                      </div>
                    ))}
                  </div>
                  <div className="p-4 rounded-lg bg-[#0C1017] border border-white/[0.06] space-y-2">
                    <div className="font-semibold text-emerald-300">CAD Modelling Guidance</div>
                    <ul className="list-disc pl-4 space-y-1 text-slate-300">
                      {diagramResult.cad_guidance.map((g, i) => (
                        <li key={i}>{g}</li>
                      ))}
                    </ul>
                  </div>
                </div>

                {diagramResult.interpretation && (
                  <div className="p-4 rounded-lg bg-[#0C1017] border border-white/[0.06] text-xs space-y-1.5">
                    <div className="font-semibold text-amber-300">Drawing Note Interpretation</div>
                    <div className="text-slate-300">{diagramResult.interpretation.summary}</div>
                    {diagramResult.interpretation.detected_standards.length > 0 && (
                      <div className="text-slate-400">
                        Standards: {diagramResult.interpretation.detected_standards.join('; ')}
                      </div>
                    )}
                    {diagramResult.interpretation.detected_tolerances.length > 0 && (
                      <div className="text-slate-400 font-mono">
                        Tolerances: {diagramResult.interpretation.detected_tolerances.join(', ')}
                      </div>
                    )}
                  </div>
                )}
              </div>
            )}
          </div>
        )}

        {/* TAB 5: SCIENTIFIC RESEARCH WORKSPACE */}
        {activeTab === 'experiments' && (
          <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
            <div className="lg:col-span-4 space-y-4">
              <form
                onSubmit={handleCreateExperiment}
                className="rounded-xl border border-white/[0.08] bg-[#11161F] p-5 space-y-3"
              >
                <div className="text-xs font-semibold text-slate-100">New Scientific Experiment</div>
                <input
                  type="text"
                  required
                  value={newExpTitle}
                  onChange={(e) => setNewExpTitle(e.target.value)}
                  placeholder="Experiment title (e.g., Beam Deflection Validation)"
                  className="w-full px-3 py-2 rounded-lg bg-[#0C1017] border border-white/[0.1] text-xs text-slate-100"
                />
                <input
                  type="text"
                  value={newExpHypothesis}
                  onChange={(e) => setNewExpHypothesis(e.target.value)}
                  placeholder="Testable hypothesis..."
                  className="w-full px-3 py-2 rounded-lg bg-[#0C1017] border border-white/[0.1] text-xs text-slate-100"
                />
                <textarea
                  rows={2}
                  value={newExpPlan}
                  onChange={(e) => setNewExpPlan(e.target.value)}
                  placeholder="Experimental apparatus & protocol..."
                  className="w-full px-3 py-2 rounded-lg bg-[#0C1017] border border-white/[0.1] text-xs text-slate-100"
                />
                <button
                  type="submit"
                  className="w-full inline-flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg bg-blue-600 hover:bg-blue-500 text-xs font-medium text-white cursor-pointer"
                >
                  <Plus className="w-3.5 h-3.5" />
                  <span>Create Experiment</span>
                </button>
              </form>

              <div className="space-y-2">
                {experiments.map((ex) => (
                  <div
                    key={ex.id}
                    className={`p-3.5 rounded-xl border flex items-start justify-between gap-2 cursor-pointer ${
                      selectedExpId === ex.id
                        ? 'bg-[#141B26] border-blue-500/50'
                        : 'bg-[#11161F] border-white/[0.08]'
                    }`}
                    onClick={() => setSelectedExpId(ex.id)}
                  >
                    <div className="min-w-0">
                      <div className="text-xs font-semibold text-slate-100 truncate">{ex.title}</div>
                      <div className="text-[11px] text-slate-400 mt-0.5">
                        {ex.observations.length} observation(s) · {ex.status}
                      </div>
                    </div>
                    <button
                      type="button"
                      aria-label="Delete experiment"
                      onClick={(e) => {
                        e.stopPropagation();
                        void apiClient.deleteExperiment(ex.id).then(() => {
                          setExperiments((prev) => prev.filter((item) => item.id !== ex.id));
                          if (selectedExpId === ex.id) setSelectedExpId('');
                        });
                      }}
                      className="p-1 text-slate-500 hover:text-red-400 cursor-pointer"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </div>
                ))}
              </div>
            </div>

            <div className="lg:col-span-8">
              {activeExperiment ? (
                <div className="rounded-xl border border-white/[0.08] bg-[#11161F] p-6 space-y-5">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <h3 className="font-display text-base font-semibold text-slate-100">
                      {activeExperiment.title}
                    </h3>
                    <span className="px-2.5 py-1 rounded bg-blue-500/10 border border-blue-500/25 text-[11px] text-blue-300">
                      {activeExperiment.discipline}
                    </span>
                  </div>

                  {/* Epistemic Separation: Facts vs Assumptions vs Hypothesis */}
                  <div className="grid grid-cols-1 md:grid-cols-3 gap-3 text-xs">
                    <div className="p-3 rounded-lg bg-[#0C1017] border border-emerald-500/20">
                      <div className="font-semibold text-emerald-300 mb-1">Established Facts</div>
                      <ul className="list-disc pl-4 space-y-0.5 text-slate-300">
                        {activeExperiment.established_facts.map((f, i) => (
                          <li key={i}>{f}</li>
                        ))}
                      </ul>
                    </div>
                    <div className="p-3 rounded-lg bg-[#0C1017] border border-amber-500/20">
                      <div className="font-semibold text-amber-300 mb-1">Assumptions</div>
                      <ul className="list-disc pl-4 space-y-0.5 text-slate-300">
                        {activeExperiment.assumptions.map((a, i) => (
                          <li key={i}>{a}</li>
                        ))}
                      </ul>
                    </div>
                    <div className="p-3 rounded-lg bg-[#0C1017] border border-blue-500/20">
                      <div className="font-semibold text-blue-300 mb-1">Hypothesis (Unproven)</div>
                      <p className="text-slate-300">{activeExperiment.hypothesis}</p>
                    </div>
                  </div>

                  {/* Add Experimental vs Theoretical Observation */}
                  <form onSubmit={handleAddObservation} className="grid grid-cols-2 sm:grid-cols-6 gap-2 items-end">
                    <div className="col-span-2 sm:col-span-1">
                      <label className="block text-[10px] text-slate-400 mb-1">Label</label>
                      <input
                        type="text"
                        value={obsLabel}
                        onChange={(e) => setObsLabel(e.target.value)}
                        className="w-full px-2 py-1.5 rounded bg-[#0C1017] border border-white/[0.1] text-xs text-slate-100"
                      />
                    </div>
                    <div>
                      <label className="block text-[10px] text-slate-400 mb-1">Input x</label>
                      <input
                        type="number"
                        step="any"
                        value={obsX}
                        onChange={(e) => setObsX(Number(e.target.value))}
                        className="w-full px-2 py-1.5 rounded bg-[#0C1017] border border-white/[0.1] text-xs text-slate-100 font-mono"
                      />
                    </div>
                    <div>
                      <label className="block text-[10px] text-slate-400 mb-1">Theoretical</label>
                      <input
                        type="number"
                        step="any"
                        value={obsTheo}
                        onChange={(e) => setObsTheo(Number(e.target.value))}
                        className="w-full px-2 py-1.5 rounded bg-[#0C1017] border border-white/[0.1] text-xs text-slate-100 font-mono"
                      />
                    </div>
                    <div>
                      <label className="block text-[10px] text-slate-400 mb-1">Measured</label>
                      <input
                        type="number"
                        step="any"
                        value={obsExp}
                        onChange={(e) => setObsExp(Number(e.target.value))}
                        className="w-full px-2 py-1.5 rounded bg-[#0C1017] border border-white/[0.1] text-xs text-slate-100 font-mono"
                      />
                    </div>
                    <div>
                      <label className="block text-[10px] text-slate-400 mb-1">Unit</label>
                      <input
                        type="text"
                        value={obsUnit}
                        onChange={(e) => setObsUnit(e.target.value)}
                        className="w-full px-2 py-1.5 rounded bg-[#0C1017] border border-white/[0.1] text-xs text-slate-100 font-mono"
                      />
                    </div>
                    <button
                      type="submit"
                      className="px-3 py-1.5 rounded bg-blue-600 hover:bg-blue-500 text-xs font-medium text-white cursor-pointer"
                    >
                      Add Data
                    </button>
                  </form>

                  {/* Comparison Table */}
                  {activeExperiment.comparison && activeExperiment.comparison.count > 0 && (
                    <div className="space-y-3">
                      <div className="p-3 rounded-lg bg-[#0C1017] border border-white/[0.06] text-xs text-emerald-300 font-mono">
                        {activeExperiment.comparison.summary}
                      </div>
                      <div className="overflow-x-auto">
                        <table className="w-full text-left text-xs font-mono">
                          <thead>
                            <tr className="border-b border-white/[0.08] text-slate-400">
                              <th className="py-1.5 pr-3">Trial</th>
                              <th className="py-1.5 pr-3">x</th>
                              <th className="py-1.5 pr-3">Theory</th>
                              <th className="py-1.5 pr-3">Measured</th>
                              <th className="py-1.5">% Error</th>
                            </tr>
                          </thead>
                          <tbody className="divide-y divide-white/[0.04]">
                            {activeExperiment.comparison.rows.map((r) => (
                              <tr key={r.id}>
                                <td className="py-1.5 pr-3 font-sans text-slate-200">{r.label}</td>
                                <td className="py-1.5 pr-3 text-slate-400">{r.x_value}</td>
                                <td className="py-1.5 pr-3 text-blue-300">{r.theoretical_value} {r.unit}</td>
                                <td className="py-1.5 pr-3 text-emerald-300">{r.experimental_value} {r.unit}</td>
                                <td className="py-1.5 text-amber-300">{r.pct_error !== null ? `${r.pct_error}%` : 'n/a'}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>

                      <EngineeringChartSvg
                        chart={{
                          title: 'Theoretical Prediction vs Experimental Measurement',
                          x_label: 'Input Parameter (x)',
                          y_label: `Value (${activeExperiment.observations[0]?.unit || ''})`,
                          x_min: Math.min(...activeExperiment.observations.map((o) => o.x_value)) - 0.5,
                          x_max: Math.max(...activeExperiment.observations.map((o) => o.x_value)) + 0.5,
                          y_min:
                            Math.min(
                              ...activeExperiment.observations.flatMap((o) => [o.theoretical_value, o.experimental_value])
                            ) * 0.9,
                          y_max:
                            Math.max(
                              ...activeExperiment.observations.flatMap((o) => [o.theoretical_value, o.experimental_value])
                            ) * 1.1,
                          series: [
                            {
                              id: 'theory',
                              label: 'Theoretical',
                              color: '#38bdf8',
                              points: activeExperiment.observations.map((o) => ({ x: o.x_value, y: o.theoretical_value })),
                            },
                            {
                              id: 'data',
                              label: 'Experimental',
                              color: '#f59e0b',
                              points: activeExperiment.observations.map((o) => ({ x: o.x_value, y: o.experimental_value })),
                            },
                          ],
                        }}
                      />
                    </div>
                  )}

                  {/* Save Experiment Report to Research / Creator */}
                  <div className="flex flex-wrap gap-2 pt-2 border-t border-white/[0.06]">
                    <button
                      type="button"
                      onClick={() => {
                        const md = [
                          `# Scientific Experiment: ${activeExperiment.title}`,
                          `## Hypothesis\n${activeExperiment.hypothesis}`,
                          `## Established Facts\n${activeExperiment.established_facts.map((f) => `- ${f}`).join('\n')}`,
                          `## Assumptions\n${activeExperiment.assumptions.map((a) => `- ${a}`).join('\n')}`,
                          `## Experimental vs Theoretical Summary\n${activeExperiment.comparison?.summary || activeExperiment.analysis_summary}`,
                        ].join('\n\n');
                        void apiClient
                          .saveEngineeringToResearch({
                            title: `Experiment: ${activeExperiment.title}`,
                            summary: activeExperiment.comparison?.summary || activeExperiment.hypothesis,
                            notes: md,
                          })
                          .then(() => setNotice('Saved scientific experiment study to Genesis Research.'))
                          .catch((e) => setError(e instanceof Error ? e.message : 'Research export failed.'));
                      }}
                      className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-[#161C26] hover:bg-[#1E2634] border border-white/[0.1] text-xs text-slate-200 cursor-pointer"
                    >
                      <BookOpen className="w-3.5 h-3.5 text-emerald-400" />
                      <span>Send to Research</span>
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        const md = [
                          `# ${activeExperiment.title}`,
                          `## Established Facts\n${activeExperiment.established_facts.map((f) => `- ${f}`).join('\n')}`,
                          `## Assumptions\n${activeExperiment.assumptions.map((a) => `- ${a}`).join('\n')}`,
                          `## Hypothesis\n${activeExperiment.hypothesis}`,
                          `## Comparison Summary\n${activeExperiment.comparison?.summary || activeExperiment.analysis_summary}`,
                        ].join('\n\n');
                        void handleExportReport(activeExperiment.title, md, 'pdf');
                      }}
                      className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-[#161C26] hover:bg-[#1E2634] border border-white/[0.1] text-xs text-slate-200 cursor-pointer"
                    >
                      <FileText className="w-3.5 h-3.5 text-blue-400" />
                      <span>Export .PDF Report</span>
                    </button>
                  </div>
                </div>
              ) : (
                <div className="rounded-xl border border-dashed border-white/[0.12] bg-[#11161F]/50 p-10 text-center text-xs text-slate-400">
                  Create or select a scientific experiment on the left to track hypotheses, physical assumptions, and measured vs. theoretical errors.
                </div>
              )}
            </div>
          </div>
        )}

        {/* TAB 6: PYTHON SCIENTIFIC SANDBOX */}
        {activeTab === 'simulation' && (
          <div className="space-y-6">
            <div className="rounded-xl border border-white/[0.08] bg-[#11161F] p-5 space-y-3">
              <div className="text-xs font-semibold text-slate-200">
                Detected Local Scientific Runtime & Simulation Adapters
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2.5 text-xs">
                {status?.simulation_tools.map((tool) => (
                  <div
                    key={tool.id}
                    className="p-3 rounded-lg bg-[#0C1017] border border-white/[0.06] flex flex-col justify-between gap-1"
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-medium text-slate-200">{tool.name}</span>
                      <span
                        className={`text-[10px] font-mono ${
                          tool.available ? 'text-emerald-400' : 'text-amber-300'
                        }`}
                      >
                        {tool.available ? tool.version || 'Installed' : 'Not Installed'}
                      </span>
                    </div>
                    <div className="text-[11px] text-slate-400">{tool.status_note}</div>
                  </div>
                ))}
              </div>
            </div>

            <form
              onSubmit={handleRunSimulation}
              className="rounded-xl border border-white/[0.08] bg-[#11161F] p-6 space-y-4"
            >
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <h3 className="font-display text-base font-semibold text-slate-100">
                    Sandboxed Python Scientific Execution
                  </h3>
                  <p className="text-xs text-slate-400 mt-0.5">
                    Runs via <span className="font-mono">python3 -I</span> with strict AST module allowlist (no os/sys/socket/open), 4s CPU cap, and 16 KB output bound.
                  </p>
                </div>
                <select
                  onChange={(e) => {
                    const p = presets.find((item) => item.id === e.target.value);
                    if (p) setSimCode(p.code);
                  }}
                  className="px-3 py-2 rounded-lg bg-[#0C1017] border border-white/[0.1] text-xs text-slate-100"
                >
                  {presets.map((p) => (
                    <option key={p.id} value={p.id}>
                      Preset: {p.title}
                    </option>
                  ))}
                </select>
              </div>

              <textarea
                rows={12}
                value={simCode}
                onChange={(e) => setSimCode(e.target.value)}
                spellCheck={false}
                className="w-full p-3.5 rounded-lg bg-[#0C1017] border border-white/[0.1] text-xs text-slate-100 font-mono leading-relaxed"
              />

              <div className="flex flex-wrap items-center justify-between gap-3">
                <label className="inline-flex items-center gap-2 text-xs text-slate-300 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={simApproved}
                    onChange={(e) => setSimApproved(e.target.checked)}
                    className="accent-blue-500"
                  />
                  <span>Approve sandboxed local Python execution (`approved: true`)</span>
                </label>

                <button
                  type="submit"
                  disabled={simBusy}
                  className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-xs font-medium text-white cursor-pointer"
                >
                  {simBusy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Play className="w-3.5 h-3.5" />}
                  <span>Run Python Simulation</span>
                </button>
              </div>

              {simResult && (
                <div className="space-y-4 pt-3 border-t border-white/[0.06]">
                  <div className="p-3.5 rounded-lg bg-[#0C1017] border border-white/[0.06] space-y-1.5">
                    <div className="text-[11px] font-mono text-slate-400">
                      Runtime: {simResult.runtime} · Duration: {simResult.duration_ms} ms · Status:{' '}
                      <strong className={simResult.ok ? 'text-emerald-400' : 'text-red-400'}>
                        {simResult.ok ? 'OK' : 'BLOCKED / ERROR'}
                      </strong>
                    </div>
                    <pre className="text-xs text-slate-200 font-mono whitespace-pre-wrap break-words">
                      {simResult.ok ? simResult.stdout : simResult.error}
                    </pre>
                  </div>
                  {simResult.chart && <EngineeringChartSvg chart={simResult.chart} />}
                </div>
              )}
            </form>
          </div>
        )}
      </div>
    </div>
  );
};
