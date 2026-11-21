import { all, create } from 'mathjs';

const math = create(all, {});

export interface UnitCategorySpec {
  id: string;
  label: string;
  si_base: string;
  units: Array<{ symbol: string; label: string }>;
}

export const SUPPORTED_UNIT_CATEGORIES: UnitCategorySpec[] = [
  {
    id: 'length',
    label: 'Length & Dimension',
    si_base: 'm',
    units: [
      { symbol: 'm', label: 'Meters (m)' },
      { symbol: 'mm', label: 'Millimeters (mm)' },
      { symbol: 'cm', label: 'Centimeters (cm)' },
      { symbol: 'km', label: 'Kilometers (km)' },
      { symbol: 'in', label: 'Inches (in)' },
      { symbol: 'ft', label: 'Feet (ft)' },
    ],
  },
  {
    id: 'area',
    label: 'Cross-Sectional Area',
    si_base: 'm^2',
    units: [
      { symbol: 'm^2', label: 'm²' },
      { symbol: 'mm^2', label: 'mm²' },
      { symbol: 'cm^2', label: 'cm²' },
      { symbol: 'in^2', label: 'in²' },
      { symbol: 'ft^2', label: 'ft²' },
    ],
  },
  {
    id: 'mass',
    label: 'Mass',
    si_base: 'kg',
    units: [
      { symbol: 'kg', label: 'Kilograms (kg)' },
      { symbol: 'g', label: 'Grams (g)' },
      { symbol: 'tonne', label: 'Metric Tonnes (t)' },
      { symbol: 'lbm', label: 'Pounds-mass (lbm)' },
    ],
  },
  {
    id: 'force',
    label: 'Force / Load',
    si_base: 'N',
    units: [
      { symbol: 'N', label: 'Newtons (N)' },
      { symbol: 'kN', label: 'Kilonewtons (kN)' },
      { symbol: 'MN', label: 'Meganewtons (MN)' },
      { symbol: 'lbf', label: 'Pounds-force (lbf)' },
    ],
  },
  {
    id: 'pressure',
    label: 'Pressure & Stress',
    si_base: 'Pa',
    units: [
      { symbol: 'Pa', label: 'Pascals (Pa)' },
      { symbol: 'kPa', label: 'Kilopascals (kPa)' },
      { symbol: 'MPa', label: 'Megapascals (MPa)' },
      { symbol: 'GPa', label: 'Gigapascals (GPa)' },
      { symbol: 'bar', label: 'Bar' },
      { symbol: 'psi', label: 'PSI (lbf/in²)' },
      { symbol: 'atm', label: 'Atmospheres (atm)' },
    ],
  },
  {
    id: 'torque',
    label: 'Torque & Moment',
    si_base: 'N*m',
    units: [
      { symbol: 'N*m', label: 'N·m' },
      { symbol: 'kN*m', label: 'kN·m' },
      { symbol: 'lbf*ft', label: 'lbf·ft' },
      { symbol: 'lbf*in', label: 'lbf·in' },
    ],
  },
  {
    id: 'power',
    label: 'Power',
    si_base: 'W',
    units: [
      { symbol: 'W', label: 'Watts (W)' },
      { symbol: 'kW', label: 'Kilowatts (kW)' },
      { symbol: 'MW', label: 'Megawatts (MW)' },
      { symbol: 'hp', label: 'Mechanical Horsepower (hp)' },
    ],
  },
  {
    id: 'energy',
    label: 'Energy & Work',
    si_base: 'J',
    units: [
      { symbol: 'J', label: 'Joules (J)' },
      { symbol: 'kJ', label: 'Kilojoules (kJ)' },
      { symbol: 'MJ', label: 'Megajoules (MJ)' },
      { symbol: 'kWh', label: 'Kilowatt-hours (kWh)' },
      { symbol: 'BTU', label: 'BTU' },
    ],
  },
  {
    id: 'velocity',
    label: 'Velocity',
    si_base: 'm/s',
    units: [
      { symbol: 'm/s', label: 'm/s' },
      { symbol: 'km/h', label: 'km/h' },
      { symbol: 'ft/s', label: 'ft/s' },
    ],
  },
  {
    id: 'volumetric_flow',
    label: 'Volumetric Flow Rate',
    si_base: 'm^3/s',
    units: [
      { symbol: 'm^3/s', label: 'm³/s' },
      { symbol: 'm^3/h', label: 'm³/h' },
      { symbol: 'L/s', label: 'L/s' },
      { symbol: 'L/min', label: 'L/min' },
      { symbol: 'gal/min', label: 'US GPM (gal/min)' },
    ],
  },
  {
    id: 'temperature',
    label: 'Temperature',
    si_base: 'K',
    units: [
      { symbol: 'K', label: 'Kelvin (K)' },
      { symbol: 'degC', label: 'Celsius (°C)' },
      { symbol: 'degF', label: 'Fahrenheit (°F)' },
    ],
  },
  {
    id: 'angle',
    label: 'Angle',
    si_base: 'rad',
    units: [
      { symbol: 'rad', label: 'Radians (rad)' },
      { symbol: 'deg', label: 'Degrees (°)' },
    ],
  },
  {
    id: 'frequency',
    label: 'Frequency & Speed',
    si_base: 'Hz',
    units: [
      { symbol: 'Hz', label: 'Hertz (Hz)' },
      { symbol: 'kHz', label: 'Kilohertz (kHz)' },
      { symbol: 'rpm', label: 'RPM (rev/min)' },
      { symbol: 'rad/s', label: 'rad/s' },
    ],
  },
  {
    id: 'electrical',
    label: 'Electrical (V, A, Ω, F, H)',
    si_base: 'V',
    units: [
      { symbol: 'V', label: 'Volts (V)' },
      { symbol: 'mV', label: 'Millivolts (mV)' },
      { symbol: 'kV', label: 'Kilovolts (kV)' },
      { symbol: 'A', label: 'Amperes (A)' },
      { symbol: 'mA', label: 'Milliamperes (mA)' },
      { symbol: 'ohm', label: 'Ohms (Ω)' },
      { symbol: 'kohm', label: 'Kilohms (kΩ)' },
      { symbol: 'uF', label: 'Microfarads (μF)' },
      { symbol: 'F', label: 'Farads (F)' },
      { symbol: 'mH', label: 'Millihenries (mH)' },
      { symbol: 'H', label: 'Henries (H)' },
    ],
  },
];

function normalizeUnitToken(raw: string): string {
  const cleaned = String(raw || '').trim();
  const alias: Record<string, string> = {
    '°C': 'degC',
    C: 'degC',
    c: 'degC',
    '°F': 'degF',
    F_temp: 'degF',
    '°': 'deg',
    'N·m': 'N*m',
    Nm: 'N*m',
    'kN·m': 'kN*m',
    kNm: 'kN*m',
    'lbf·ft': 'lbf*ft',
    'ft-lbf': 'lbf*ft',
    'in-lbf': 'lbf*in',
    gpm: 'gal/min',
    GPM: 'gal/min',
    lpm: 'L/min',
    LPM: 'L/min',
    t: 'tonne',
    μF: 'uF',
    µF: 'uF',
    Ω: 'ohm',
    'kΩ': 'kohm',
  };
  return alias[cleaned] || cleaned;
}

export interface UnitConversionResult {
  ok: boolean;
  input_value: number;
  from_unit: string;
  to_unit: string;
  output_value: number;
  formatted: string;
  conversion_note: string;
}

function toBaseRate(value: number, fromUnit: string, toUnit: string): number | null {
  const f = normalizeUnitToken(fromUnit);
  const t = normalizeUnitToken(toUnit);

  // Explicit angular velocity / RPM bridge
  const angToRadSec: Record<string, number> = {
    'rad/s': 1,
    rpm: (2 * Math.PI) / 60,
    Hz: 2 * Math.PI,
    kHz: 2000 * Math.PI,
  };
  if (angToRadSec[f] && angToRadSec[t]) {
    return (value * angToRadSec[f]) / angToRadSec[t];
  }

  // Explicit kN*m / N*m / lbf*ft / lbf*in torque conversion
  const torqueToNm: Record<string, number> = {
    'N*m': 1,
    'kN*m': 1000,
    'lbf*ft': 1.3558179483314004,
    'lbf*in': 0.1129848290276167,
  };
  if (torqueToNm[f] && torqueToNm[t]) {
    return (value * torqueToNm[f]) / torqueToNm[t];
  }

  // Explicit volumetric flow rate conversion (including US GPM and L/min)
  const flowToM3s: Record<string, number> = {
    'm^3/s': 1,
    'm^3/h': 1 / 3600,
    'L/s': 0.001,
    'L/min': 0.001 / 60,
    'gal/min': 0.003785411784 / 60,
  };
  if (flowToM3s[f] && flowToM3s[t]) {
    return (value * flowToM3s[f]) / flowToM3s[t];
  }

  // Explicit mass conversion including lbm / tonne
  const massToKg: Record<string, number> = {
    kg: 1,
    g: 0.001,
    mg: 1e-6,
    tonne: 1000,
    lb: 0.45359237,
    lbm: 0.45359237,
    oz: 0.028349523125,
  };
  if (massToKg[f] && massToKg[t]) {
    return (value * massToKg[f]) / massToKg[t];
  }

  // Explicit electrical conversion safeguard
  const elecScale: Record<string, { dim: string; factor: number }> = {
    V: { dim: 'V', factor: 1 },
    mV: { dim: 'V', factor: 1e-3 },
    kV: { dim: 'V', factor: 1e3 },
    A: { dim: 'A', factor: 1 },
    mA: { dim: 'A', factor: 1e-3 },
    ohm: { dim: 'R', factor: 1 },
    kohm: { dim: 'R', factor: 1e3 },
    Mohm: { dim: 'R', factor: 1e6 },
    F: { dim: 'C', factor: 1 },
    mF: { dim: 'C', factor: 1e-3 },
    uF: { dim: 'C', factor: 1e-6 },
    nF: { dim: 'C', factor: 1e-9 },
    H: { dim: 'L', factor: 1 },
    mH: { dim: 'L', factor: 1e-3 },
    uH: { dim: 'L', factor: 1e-6 },
  };
  if (elecScale[f] && elecScale[t]) {
    if (elecScale[f].dim !== elecScale[t].dim) {
      throw new Error(`Incompatible electrical dimensions: cannot convert "${fromUnit}" to "${toUnit}".`);
    }
    return (value * elecScale[f].factor) / elecScale[t].factor;
  }

  return null;
}

export function convertUnitValue(
  value: number,
  fromUnit: string,
  toUnit: string
): UnitConversionResult {
  if (!Number.isFinite(value)) {
    throw new Error('Input value must be a finite real number.');
  }

  const normFrom = normalizeUnitToken(fromUnit);
  const normTo = normalizeUnitToken(toUnit);
  if (!normFrom || !normTo) {
    throw new Error('Both source and target units are required.');
  }

  if (normFrom === normTo) {
    return {
      ok: true,
      input_value: value,
      from_unit: fromUnit,
      to_unit: toUnit,
      output_value: value,
      formatted: `${Number(value.toPrecision(8))} ${toUnit}`,
      conversion_note: `Identity conversion (${fromUnit} -> ${toUnit}).`,
    };
  }

  // Kelvin / Celsius / Fahrenheit absolute floor check
  if (normFrom === 'K' && value < 0) {
    throw new Error('Absolute temperature in Kelvin (K) cannot be negative.');
  }
  if (normFrom === 'degC' && value < -273.15) {
    throw new Error('Temperature in °C cannot be below absolute zero (-273.15 °C).');
  }
  if (normFrom === 'degF' && value < -459.67) {
    throw new Error('Temperature in °F cannot be below absolute zero (-459.67 °F).');
  }

  const special = toBaseRate(value, normFrom, normTo);
  if (special !== null) {
    return {
      ok: true,
      input_value: value,
      from_unit: fromUnit,
      to_unit: toUnit,
      output_value: special,
      formatted: `${Number(special.toPrecision(7))} ${toUnit}`,
      conversion_note: `Exact conversion from ${value} ${fromUnit} to ${toUnit}.`,
    };
  }

  try {
    const q = math.unit(value, normFrom);
    const out = q.toNumber(normTo);
    if (!Number.isFinite(out)) {
      throw new Error('Unit conversion yielded non-finite result.');
    }
    return {
      ok: true,
      input_value: value,
      from_unit: fromUnit,
      to_unit: toUnit,
      output_value: out,
      formatted: `${Number(out.toPrecision(7))} ${toUnit}`,
      conversion_note: `Dimensional conversion via mathjs: ${value} ${fromUnit} = ${Number(out.toPrecision(7))} ${toUnit}`,
    };
  } catch (err) {
    throw new Error(
      err instanceof Error
        ? `Unit conversion failed (${fromUnit} -> ${toUnit}): ${err.message}`
        : `Incompatible or unknown units: ${fromUnit} -> ${toUnit}`
    );
  }
}

export function requireSI(value: unknown, unit: string | undefined, expectedSiUnit: string, label: string): number {
  const num = Number(value);
  if (!Number.isFinite(num)) {
    throw new Error(`${label} must be a valid finite number.`);
  }
  const srcUnit = (unit || expectedSiUnit).trim();
  const converted = convertUnitValue(num, srcUnit, expectedSiUnit);
  return converted.output_value;
}
