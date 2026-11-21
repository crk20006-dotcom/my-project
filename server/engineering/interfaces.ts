export type EngineeringDisciplineId =
  | 'mechanical'
  | 'electrical'
  | 'civil'
  | 'computer_science'
  | 'manufacturing'
  | 'cad_3d'
  | 'fluid_power'
  | 'machine_design';

export type CalculatorId =
  | 'stress_strain'
  | 'force_torque_power'
  | 'motion_kinematics'
  | 'thermodynamics'
  | 'fluid_flow_pressure'
  | 'pump_compressor'
  | 'gear_shaft_design'
  | 'electrical_circuits';

export interface CalculationStep {
  label: string;
  formula: string;
  substitution: string;
  result: string;
}

export interface ValidationWarning {
  severity: 'info' | 'warning' | 'critical';
  code: string;
  message: string;
}

export interface ComputedQuantity {
  key: string;
  label: string;
  value: number;
  unit: string;
  formatted: string;
  kind: 'exact_closed_form' | 'numerical_method' | 'engineering_estimate';
  reference_note?: string;
}

export interface CalculationResult {
  ok: boolean;
  calculator: CalculatorId;
  title: string;
  inputs_si: Record<string, { value: number; unit: string }>;
  outputs: ComputedQuantity[];
  steps: CalculationStep[];
  assumptions: string[];
  limitations: string[];
  independent_check: {
    passed: boolean;
    method: string;
    detail: string;
  };
  warnings: ValidationWarning[];
  safety_notice: string;
}

export interface PlotSeries {
  id: string;
  label: string;
  color: string;
  points: Array<{ x: number; y: number }>;
}

export interface PlotChartSpec {
  title: string;
  x_label: string;
  y_label: string;
  x_min: number;
  x_max: number;
  y_min: number;
  y_max: number;
  series: PlotSeries[];
  markers?: Array<{ x: number; y: number; label: string; color?: string }>;
}

export type MathOperationType =
  | 'evaluate'
  | 'derivative'
  | 'integral'
  | 'matrix_solve'
  | 'matrix_analyze'
  | 'ode_rk4'
  | 'root_find'
  | 'statistics_regression';

export interface MathComputationResult {
  ok: boolean;
  operation: MathOperationType;
  summary: string;
  result_value: string | number | Record<string, unknown>;
  steps: string[];
  verification?: {
    passed: boolean;
    method: string;
    residual?: number;
    detail: string;
  };
  warnings: string[];
  chart?: PlotChartSpec;
}

export type EngineeringDiagramKind =
  | 'beam_load'
  | 'shaft_step'
  | 'pressure_vessel'
  | 'rlc_circuit'
  | 'pipe_system';

export interface EngineeringDiagramResult {
  ok: boolean;
  kind: EngineeringDiagramKind;
  title: string;
  svg: string;
  dimensions: Array<{ callout: string; value: string; tolerance?: string }>;
  cad_guidance: string[];
  drawing_notes: string[];
  interpretation?: {
    detected_standards: string[];
    detected_tolerances: string[];
    detected_dimensions: string[];
    summary: string;
  };
}

export interface ExperimentalObservation {
  id: string;
  label: string;
  x_value: number;
  theoretical_value: number;
  experimental_value: number;
  unit: string;
}

export interface ScientificExperimentRecord {
  id: string;
  title: string;
  discipline: EngineeringDisciplineId;
  objective: string;
  established_facts: string[];
  assumptions: string[];
  hypothesis: string;
  experimental_plan: string;
  observations: ExperimentalObservation[];
  analysis_summary: string;
  sources: Array<{ title: string; reference: string; reliability: 'established_standard' | 'peer_reviewed' | 'preliminary_note' }>;
  status: 'planned' | 'in_progress' | 'analyzed' | 'concluded';
  created_at: string;
  updated_at: string;
}

export interface SimulationToolDescriptor {
  id: string;
  name: string;
  runtime: string;
  available: boolean;
  version: string | null;
  status_note: string;
}

export interface SimulationExecutionResult {
  ok: boolean;
  runtime: string;
  approved: boolean;
  duration_ms: number;
  stdout: string;
  parsed_json?: Record<string, unknown> | null;
  chart?: PlotChartSpec;
  error?: string;
  resource_limits: {
    timeout_ms: number;
    max_stdout_bytes: number;
    isolated_mode: boolean;
  };
}

export interface SimulationToolAdapter {
  readonly id: string;
  probeCapabilities(): Promise<SimulationToolDescriptor[]>;
  runRestrictedScript(code: string, approved: boolean, timeoutMs?: number): Promise<SimulationExecutionResult>;
}
