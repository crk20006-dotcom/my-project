import type {
  CalculationResult,
  CalculationStep,
  CalculatorId,
  ComputedQuantity,
  ValidationWarning,
} from './interfaces.ts';
import { requireSI } from './unitEngine.ts';

const SAFETY_DISCLAIMER =
  'Preliminary engineering analysis only. Results rely on idealized physical models listed in Assumptions and MUST be independently verified by a licensed Professional Engineer (PE) or applicable code authority before safety-critical fabrication or operation.';

function fmt(n: number, digits = 6): string {
  if (!Number.isFinite(n)) return 'NaN';
  if (n === 0) return '0';
  const abs = Math.abs(n);
  if (abs >= 1e5 || abs < 1e-3) {
    return n.toExponential(4);
  }
  return Number(n.toPrecision(digits)).toString();
}

function posSI(val: unknown, unit: string | undefined, expectedSi: string, label: string): number {
  const num = requireSI(val, unit, expectedSi, label);
  if (num <= 0) {
    throw new Error(`${label} must be strictly positive (> 0). Received ${num} ${expectedSi}.`);
  }
  return num;
}

export function runEngineeringCalculation(
  calculator: CalculatorId,
  rawInputs: Record<string, { value: number; unit?: string } | number>
): CalculationResult {
  const readVal = (key: string, defaultVal?: number, defaultUnit?: string): { v: number; u?: string } => {
    const raw = rawInputs[key];
    if (raw === undefined || raw === null) {
      if (defaultVal !== undefined) return { v: defaultVal, u: defaultUnit };
      throw new Error(`Missing required input field "${key}".`);
    }
    if (typeof raw === 'number') return { v: raw, u: defaultUnit };
    return { v: Number(raw.value), u: raw.unit || defaultUnit };
  };

  const warnings: ValidationWarning[] = [];

  if (calculator === 'stress_strain') {
    const fIn = readVal('force', undefined, 'N');
    const aIn = readVal('area', undefined, 'mm^2');
    const lIn = readVal('length', 1, 'm');
    const eIn = readVal('modulus', 205, 'GPa');
    const syIn = readVal('yield_strength', 310, 'MPa');

    const F = requireSI(fIn.v, fIn.u, 'N', 'Applied Force');
    const A = posSI(aIn.v, aIn.u, 'm^2', 'Cross-sectional Area');
    const L = posSI(lIn.v, lIn.u, 'm', 'Member Length');
    const E = posSI(eIn.v, eIn.u, 'Pa', 'Young’s Modulus');
    const Sy = posSI(syIn.v, syIn.u, 'Pa', 'Yield Strength');

    const sigma = F / A; // Pa
    const absSigma = Math.abs(sigma);
    const strain = sigma / E;
    const elongation = strain * L;
    const fos = absSigma > 0 ? Sy / absSigma : Number.POSITIVE_INFINITY;

    // Independent energy-balance check: strain energy U = 0.5 * k * delta^2 == 0.5 * F * delta
    const kAxial = (A * E) / L;
    const uWork = 0.5 * F * elongation;
    const uSpring = 0.5 * kAxial * elongation * elongation;
    const residual = Math.abs(uWork - uSpring);

    if (fos < 1.0) {
      warnings.push({
        severity: 'critical',
        code: 'YIELD_EXCEEDED',
        message: `Calculated stress (${fmt(absSigma / 1e6)} MPa) exceeds yield strength (${fmt(Sy / 1e6)} MPa). Linear Hooke’s law is invalid past yield.`,
      });
    } else if (fos < 1.5) {
      warnings.push({
        severity: 'warning',
        code: 'LOW_FACTOR_OF_SAFETY',
        message: `Factor of safety (${fmt(fos, 3)}) is below typical static threshold (1.5).`,
      });
    }

    if (Math.abs(strain) > 0.05) {
      warnings.push({
        severity: 'warning',
        code: 'LARGE_STRAIN_LIMIT',
        message: 'Engineering strain exceeds 5%; small-strain linear elasticity breaks down.',
      });
    }

    return {
      ok: true,
      calculator,
      title: 'Axial Stress, Strain & Yield Safety Analysis',
      inputs_si: {
        force: { value: F, unit: 'N' },
        area: { value: A, unit: 'm^2' },
        length: { value: L, unit: 'm' },
        modulus: { value: E, unit: 'Pa' },
        yield_strength: { value: Sy, unit: 'Pa' },
      },
      outputs: [
        { key: 'stress_mpa', label: 'Normal Stress (σ)', value: sigma / 1e6, unit: 'MPa', formatted: `${fmt(sigma / 1e6)} MPa`, kind: 'exact_closed_form' },
        { key: 'strain_micro', label: 'Axial Strain (ε)', value: strain * 1e6, unit: 'με (×10⁻⁶)', formatted: `${fmt(strain * 1e6)} με`, kind: 'exact_closed_form' },
        { key: 'elongation_mm', label: 'Axial Elongation (δ)', value: elongation * 1e3, unit: 'mm', formatted: `${fmt(elongation * 1e3)} mm`, kind: 'exact_closed_form' },
        { key: 'axial_stiffness', label: 'Axial Stiffness (k = AE/L)', value: kAxial / 1e6, unit: 'MN/m', formatted: `${fmt(kAxial / 1e6)} MN/m`, kind: 'exact_closed_form' },
        { key: 'factor_of_safety', label: 'Yield Factor of Safety (Sy / |σ|)', value: fos, unit: 'dimensionless', formatted: Number.isFinite(fos) ? fmt(fos, 4) : '∞', kind: 'exact_closed_form' },
      ],
      steps: [
        { label: 'Convert area to m² and evaluate stress', formula: 'σ = F / A', substitution: `${fmt(F)} N / ${fmt(A)} m²`, result: `${fmt(sigma / 1e6)} MPa` },
        { label: 'Apply Hooke’s law for uniaxial strain', formula: 'ε = σ / E', substitution: `${fmt(sigma)} Pa / ${fmt(E)} Pa`, result: `${fmt(strain * 1e6)} με` },
        { label: 'Integrate displacement over length L', formula: 'δ = ε · L', substitution: `${fmt(strain)} × ${fmt(L)} m`, result: `${fmt(elongation * 1e3)} mm` },
        { label: 'Yield safety factor', formula: 'n = Sy / |σ|', substitution: `${fmt(Sy / 1e6)} MPa / ${fmt(absSigma / 1e6)} MPa`, result: Number.isFinite(fos) ? fmt(fos, 4) : '∞' },
      ],
      assumptions: [
        'Uniform uniaxial load applied through the centroidal axis (no eccentric bending).',
        'Homogeneous, isotropic, linear-elastic material below proportional limit.',
        'Does not account for Euler column buckling under compression or notch stress concentrations.',
      ],
      limitations: ['Buckling stability must be checked separately if member is slender in compression.'],
      independent_check: {
        passed: residual <= Math.max(1e-9, Math.abs(uWork) * 1e-9),
        method: 'Elastic Strain Energy Equivalence (0.5·F·δ == 0.5·k·δ²)',
        detail: `U_work = ${fmt(uWork)} J vs U_stiffness = ${fmt(uSpring)} J (residual = ${fmt(residual)} J).`,
      },
      warnings,
      safety_notice: SAFETY_DISCLAIMER,
    };
  }

  if (calculator === 'force_torque_power') {
    const fIn = readVal('force', 500, 'N');
    const rIn = readVal('radius', 0.25, 'm');
    const rpmIn = readVal('speed', 1200, 'rpm');
    const effIn = readVal('efficiency', 0.9, '1');

    const F = requireSI(fIn.v, fIn.u, 'N', 'Tangential Force');
    const r = posSI(rIn.v, rIn.u, 'm', 'Lever Arm Radius');
    const omega = posSI(rpmIn.v, rpmIn.u, 'rad/s', 'Rotational Speed');
    const eta = Number(effIn.v);
    if (!Number.isFinite(eta) || eta <= 0 || eta > 1) {
      throw new Error('Mechanical efficiency must be between (0, 1.0].');
    }

    const torque = F * r;
    const tangentialVelocity = omega * r;
    const mechPower = torque * omega;
    const linearPower = F * tangentialVelocity;
    const inputPower = mechPower / eta;

    if (tangentialVelocity > 100) {
      warnings.push({
        severity: 'warning',
        code: 'HIGH_RIM_SPEED',
        message: `Surface rim velocity (${fmt(tangentialVelocity)} m/s) is high; verify dynamic balancing & centrifugal hoop stress.`,
      });
    }

    return {
      ok: true,
      calculator,
      title: 'Force, Torque, Angular Velocity & Shaft Power',
      inputs_si: {
        force: { value: F, unit: 'N' },
        radius: { value: r, unit: 'm' },
        omega: { value: omega, unit: 'rad/s' },
        efficiency: { value: eta, unit: 'ratio' },
      },
      outputs: [
        { key: 'torque_nm', label: 'Shaft Torque (τ = F · r)', value: torque, unit: 'N·m', formatted: `${fmt(torque)} N·m`, kind: 'exact_closed_form' },
        { key: 'tangential_v', label: 'Tangential Rim Velocity (v = ωr)', value: tangentialVelocity, unit: 'm/s', formatted: `${fmt(tangentialVelocity)} m/s`, kind: 'exact_closed_form' },
        { key: 'mech_power_kw', label: 'Output Shaft Power (P_out = τω)', value: mechPower / 1000, unit: 'kW', formatted: `${fmt(mechPower / 1000)} kW (${fmt(mechPower / 745.69987)} hp)`, kind: 'exact_closed_form' },
        { key: 'input_power_kw', label: 'Required Input Power (P_out / η)', value: inputPower / 1000, unit: 'kW', formatted: `${fmt(inputPower / 1000)} kW`, kind: 'exact_closed_form' },
      ],
      steps: [
        { label: 'Torque at radius r', formula: 'τ = F · r', substitution: `${fmt(F)} N × ${fmt(r)} m`, result: `${fmt(torque)} N·m` },
        { label: 'Linear speed at radius r', formula: 'v = ω · r', substitution: `${fmt(omega)} rad/s × ${fmt(r)} m`, result: `${fmt(tangentialVelocity)} m/s` },
        { label: 'Mechanical shaft power', formula: 'P_out = τ · ω', substitution: `${fmt(torque)} N·m × ${fmt(omega)} rad/s`, result: `${fmt(mechPower / 1000)} kW` },
        { label: 'Required drive input power', formula: 'P_in = P_out / η', substitution: `${fmt(mechPower / 1000)} kW / ${eta}`, result: `${fmt(inputPower / 1000)} kW` },
      ],
      assumptions: ['Steady-state rotational speed and constant load angle perpendicular to lever arm.', 'Constant lumped mechanical efficiency η.'],
      limitations: ['Starting/inertial acceleration torque (τ_accel = I·α) is excluded.'],
      independent_check: {
        passed: Math.abs(mechPower - linearPower) <= Math.max(1e-9, Math.abs(mechPower) * 1e-9),
        method: 'Rotational vs Linear Power Identity (τ·ω == F·v)',
        detail: `τ·ω = ${fmt(mechPower)} W vs F·v = ${fmt(linearPower)} W.`,
      },
      warnings,
      safety_notice: SAFETY_DISCLAIMER,
    };
  }

  if (calculator === 'motion_kinematics') {
    const v0In = readVal('initial_velocity', 0, 'm/s');
    const aIn = readVal('acceleration', 2.5, 'm/s^2');
    const tIn = readVal('time', 4, 's');
    const mIn = readVal('mass', 10, 'kg');

    const v0 = requireSI(v0In.v, v0In.u, 'm/s', 'Initial Velocity');
    const a = Number(aIn.v);
    if (!Number.isFinite(a)) throw new Error('Acceleration must be a finite number (m/s²).');
    const t = requireSI(tIn.v, tIn.u, 's', 'Time Duration');
    if (t < 0) throw new Error('Time duration cannot be negative.');
    const mass = posSI(mIn.v, mIn.u, 'kg', 'Body Mass');

    const vf = v0 + a * t;
    const displacement = v0 * t + 0.5 * a * t * t;
    const workDone = mass * a * displacement;
    const deltaKe = 0.5 * mass * (vf * vf - v0 * v0);

    if (Math.abs(vf) > 343) {
      warnings.push({
        severity: 'info',
        code: 'SUPERSONIC_VELOCITY',
        message: 'Final speed exceeds sea-level speed of sound (~343 m/s); aerodynamic drag models are non-linear here.',
      });
    }

    return {
      ok: true,
      calculator,
      title: '1D Constant-Acceleration Kinematics & Work-Energy Balance',
      inputs_si: {
        initial_velocity: { value: v0, unit: 'm/s' },
        acceleration: { value: a, unit: 'm/s^2' },
        time: { value: t, unit: 's' },
        mass: { value: mass, unit: 'kg' },
      },
      outputs: [
        { key: 'final_velocity', label: 'Final Velocity (v)', value: vf, unit: 'm/s', formatted: `${fmt(vf)} m/s (${fmt(vf * 3.6)} km/h)`, kind: 'exact_closed_form' },
        { key: 'displacement', label: 'Displacement (Δx)', value: displacement, unit: 'm', formatted: `${fmt(displacement)} m`, kind: 'exact_closed_form' },
        { key: 'net_force', label: 'Net Force (F = m·a)', value: mass * a, unit: 'N', formatted: `${fmt(mass * a)} N`, kind: 'exact_closed_form' },
        { key: 'delta_ke', label: 'Kinetic Energy Change (ΔKE)', value: deltaKe, unit: 'J', formatted: `${fmt(deltaKe)} J`, kind: 'exact_closed_form' },
      ],
      steps: [
        { label: 'Final velocity', formula: 'v = v₀ + a·t', substitution: `${fmt(v0)} + (${fmt(a)} × ${fmt(t)})`, result: `${fmt(vf)} m/s` },
        { label: 'Displacement', formula: 'Δx = v₀·t + ½·a·t²', substitution: `${fmt(v0 * t)} + 0.5×${fmt(a)}×${fmt(t * t)}`, result: `${fmt(displacement)} m` },
        { label: 'Work-energy change', formula: 'ΔKE = ½·m·(v² - v₀²)', substitution: `0.5 × ${fmt(mass)} × (${fmt(vf * vf)} - ${fmt(v0 * v0)})`, result: `${fmt(deltaKe)} J` },
      ],
      assumptions: ['Constant net acceleration in an inertial reference frame.', 'Classical non-relativistic mechanics (v ≪ c).'],
      limitations: ['Variable friction or velocity-dependent aerodynamic drag requires RK4 ODE integration in Mathematics workspace.'],
      independent_check: {
        passed: Math.abs(workDone - deltaKe) <= Math.max(1e-7, Math.abs(deltaKe) * 1e-9),
        method: 'Work-Energy Theorem (F_net·Δx == ΔKE)',
        detail: `W_net = ${fmt(workDone)} J vs ΔKE = ${fmt(deltaKe)} J.`,
      },
      warnings,
      safety_notice: SAFETY_DISCLAIMER,
    };
  }

  if (calculator === 'thermodynamics') {
    const tHotIn = readVal('t_hot', 550, 'K');
    const tColdIn = readVal('t_cold', 300, 'K');
    const pIn = readVal('pressure', 101.325, 'kPa');
    const volIn = readVal('volume', 0.05, 'm^3');
    const molesIn = readVal('moles', 2.0, 'mol');

    const Th = requireSI(tHotIn.v, tHotIn.u, 'K', 'Hot Reservoir Temperature');
    const Tc = requireSI(tColdIn.v, tColdIn.u, 'K', 'Cold Reservoir Temperature');
    const P = posSI(pIn.v, pIn.u, 'Pa', 'Gas Pressure');
    const V = posSI(volIn.v, volIn.u, 'm^3', 'Volume');
    const n = Number(molesIn.v);
    if (!Number.isFinite(n) || n <= 0) throw new Error('Amount of gas (n moles) must be positive.');
    if (Tc >= Th) throw new Error('Cold reservoir temperature (Tc) must be strictly lower than hot reservoir temperature (Th) for a heat engine.');

    const R = 8.314462618; // J/(mol·K)
    const carnotEff = 1 - Tc / Th;
    const copRefrig = Tc / (Th - Tc);
    const idealTempK = (P * V) / (n * R);
    const calculatedP = (n * R * Th) / V;

    if (carnotEff > 0.75) {
      warnings.push({
        severity: 'info',
        code: 'CARNOT_UPPER_BOUND',
        message: 'Carnot efficiency is a theoretical reversible limit; real Rankine/Brayton/Otto engines typically achieve 45–65% of Carnot.',
      });
    }

    return {
      ok: true,
      calculator,
      title: 'Carnot Heat Engine Limit & Ideal Gas State',
      inputs_si: {
        t_hot: { value: Th, unit: 'K' },
        t_cold: { value: Tc, unit: 'K' },
        pressure: { value: P, unit: 'Pa' },
        volume: { value: V, unit: 'm^3' },
        moles: { value: n, unit: 'mol' },
      },
      outputs: [
        { key: 'carnot_efficiency_pct', label: 'Carnot Max Efficiency (η_c = 1 - Tc/Th)', value: carnotEff * 100, unit: '%', formatted: `${fmt(carnotEff * 100, 5)}%`, kind: 'exact_closed_form' },
        { key: 'cop_cooling', label: 'Max Reversible Cooling COP', value: copRefrig, unit: 'dimensionless', formatted: fmt(copRefrig, 4), kind: 'exact_closed_form' },
        { key: 'ideal_gas_temp_k', label: 'Gas Temperature from PV/nR', value: idealTempK, unit: 'K', formatted: `${fmt(idealTempK)} K (${fmt(idealTempK - 273.15)} °C)`, kind: 'exact_closed_form' },
        { key: 'pressure_at_th_kpa', label: 'Isochoric Pressure at Th (nRTh/V)', value: calculatedP / 1000, unit: 'kPa', formatted: `${fmt(calculatedP / 1000)} kPa`, kind: 'exact_closed_form' },
      ],
      steps: [
        { label: 'Convert temperatures to Kelvin and compute Carnot ceiling', formula: 'η_c = 1 - Tc / Th', substitution: `1 - ${fmt(Tc)} K / ${fmt(Th)} K`, result: `${fmt(carnotEff * 100, 5)}%` },
        { label: 'Evaluate ideal gas temperature', formula: 'T = (P · V) / (n · R)', substitution: `(${fmt(P)} × ${fmt(V)}) / (${n} × 8.3145)`, result: `${fmt(idealTempK)} K` },
      ],
      assumptions: ['Reversible Carnot cycle (no friction, heat leaks, or finite ΔT irreversibilities).', 'Ideal gas behavior (low reduced pressure P << P_crit, non-condensing).'],
      limitations: ['Real steam/refrigerant cycles near saturation require Helmholtz/CoolProp equations of state.'],
      independent_check: {
        passed: Math.abs((P * V) / (n * R * idealTempK) - 1) < 1e-12,
        method: 'Thermodynamic Compressibility Consistency Check (PV / nRT == 1.0)',
        detail: `PV / nRT = ${fmt((P * V) / (n * R * idealTempK), 10)} (exact ideal state satisfied).`,
      },
      warnings,
      safety_notice: SAFETY_DISCLAIMER,
    };
  }

  if (calculator === 'fluid_flow_pressure') {
    const dIn = readVal('diameter', 0.05, 'm');
    const lIn = readVal('length', 25, 'm');
    const qIn = readVal('flow_rate', 0.004, 'm^3/s');
    const rhoIn = readVal('density', 998, '1');
    const muIn = readVal('viscosity', 0.001, '1');
    const epsIn = readVal('roughness', 0.045, 'mm');

    const D = posSI(dIn.v, dIn.u, 'm', 'Pipe Inner Diameter');
    const L = posSI(lIn.v, lIn.u, 'm', 'Pipe Length');
    const Q = posSI(qIn.v, qIn.u, 'm^3/s', 'Volumetric Flow Rate');
    const rho = Number(rhoIn.v);
    const mu = Number(muIn.v);
    if (!Number.isFinite(rho) || rho <= 0) throw new Error('Fluid density (kg/m³) must be positive.');
    if (!Number.isFinite(mu) || mu <= 0) throw new Error('Dynamic viscosity (Pa·s) must be positive.');
    const eps = Math.max(0, requireSI(epsIn.v, epsIn.u, 'm', 'Absolute Pipe Roughness'));

    const area = (Math.PI * D * D) / 4;
    const velocity = Q / area;
    const reynolds = (rho * velocity * D) / mu;

    let regime = 'Laminar';
    let frictionFactor = 64 / reynolds;
    if (reynolds >= 2300) {
      regime = reynolds < 4000 ? 'Transitional (Uncertain Friction)' : 'Turbulent';
      // Haaland explicit approximation to Colebrook-White
      const relRough = eps / D;
      const invSqrtF = -1.8 * Math.log10(Math.pow(relRough / 3.7, 1.11) + 6.9 / reynolds);
      frictionFactor = 1 / (invSqrtF * invSqrtF);
    }

    const deltaP = frictionFactor * (L / D) * (0.5 * rho * velocity * velocity);
    const headLoss = deltaP / (rho * 9.80665);

    // Independent mass conservation check
    const massFlow = rho * Q;
    const recomputedQ = area * velocity;

    if (reynolds >= 2300 && reynolds <= 4000) {
      warnings.push({
        severity: 'warning',
        code: 'TRANSITIONAL_FLOW',
        message: `Reynolds number (${Math.round(reynolds)}) lies in transitional regime (2300–4000); friction factor carries ±25% uncertainty.`,
      });
    }
    if (velocity > 6) {
      warnings.push({
        severity: 'warning',
        code: 'HIGH_PIPE_VELOCITY',
        message: `Liquid velocity (${fmt(velocity)} m/s) exceeds typical erosion/water-hammer guideline (~3–5 m/s).`,
      });
    }

    return {
      ok: true,
      calculator,
      title: 'Darcy-Weisbach Pipe Flow & Pressure Drop',
      inputs_si: {
        diameter: { value: D, unit: 'm' },
        length: { value: L, unit: 'm' },
        flow_rate: { value: Q, unit: 'm^3/s' },
        density: { value: rho, unit: 'kg/m^3' },
        viscosity: { value: mu, unit: 'Pa*s' },
      },
      outputs: [
        { key: 'velocity', label: 'Mean Flow Velocity (v = Q/A)', value: velocity, unit: 'm/s', formatted: `${fmt(velocity)} m/s`, kind: 'exact_closed_form' },
        { key: 'reynolds', label: 'Reynolds Number (Re)', value: reynolds, unit: 'dimensionless', formatted: `${Math.round(reynolds).toLocaleString()} (${regime})`, kind: 'exact_closed_form' },
        { key: 'friction_factor', label: 'Darcy Friction Factor (f)', value: frictionFactor, unit: 'dimensionless', formatted: fmt(frictionFactor, 5), kind: reynolds < 2300 ? 'exact_closed_form' : 'numerical_method', reference_note: reynolds < 2300 ? '64/Re' : 'Haaland approximation (±1.5% vs Colebrook)' },
        { key: 'pressure_drop_kpa', label: 'Pressure Drop (ΔP)', value: deltaP / 1000, unit: 'kPa', formatted: `${fmt(deltaP / 1000)} kPa (${fmt(deltaP / 6894.757)} psi)`, kind: 'numerical_method' },
        { key: 'head_loss_m', label: 'Head Loss (h_f)', value: headLoss, unit: 'm fluid', formatted: `${fmt(headLoss)} m`, kind: 'numerical_method' },
      ],
      steps: [
        { label: 'Mean velocity from continuity', formula: 'v = Q / (πD²/4)', substitution: `${fmt(Q)} m³/s / ${fmt(area)} m²`, result: `${fmt(velocity)} m/s` },
        { label: 'Reynolds number', formula: 'Re = ρvD / μ', substitution: `${rho}×${fmt(velocity)}×${fmt(D)} / ${mu}`, result: `${Math.round(reynolds)} (${regime})` },
        { label: 'Friction factor & Darcy-Weisbach drop', formula: 'ΔP = f·(L/D)·(½ρv²)', substitution: `${fmt(frictionFactor, 4)}×(${fmt(L)}/${fmt(D)})×${fmt(0.5 * rho * velocity * velocity)} Pa`, result: `${fmt(deltaP / 1000)} kPa` },
      ],
      assumptions: ['Fully developed, steady, incompressible Newtonian flow in a full circular pipe.', 'Straight conduit; minor losses from valves/elbows (ΣK v²/2g) must be added separately.'],
      limitations: ['Haaland explicit friction correlation estimates Colebrook-White within ~1.5% for turbulent smooth/rough pipes.'],
      independent_check: {
        passed: Math.abs(recomputedQ - Q) <= 1e-12,
        method: 'Continuity Conservation Check (A·v == Q, ṁ = ρ·Q)',
        detail: `Reconstructed Q = ${fmt(recomputedQ)} m³/s; mass flow ṁ = ${fmt(massFlow)} kg/s.`,
      },
      warnings,
      safety_notice: SAFETY_DISCLAIMER,
    };
  }

  if (calculator === 'pump_compressor') {
    const qIn = readVal('flow_rate', 0.02, 'm^3/s');
    const hIn = readVal('head', 35, 'm');
    const rhoIn = readVal('density', 998, '1');
    const etaIn = readVal('efficiency', 0.72, '1');

    const Q = posSI(qIn.v, qIn.u, 'm^3/s', 'Pump Flow Rate');
    const H = posSI(hIn.v, hIn.u, 'm', 'Total Dynamic Head');
    const rho = Number(rhoIn.v);
    const eta = Number(etaIn.v);
    if (!Number.isFinite(rho) || rho <= 0) throw new Error('Fluid density must be positive.');
    if (!Number.isFinite(eta) || eta <= 0 || eta > 1) throw new Error('Pump efficiency must be in (0, 1.0].');

    const g = 9.80665;
    const hydraulicPower = rho * g * Q * H;
    const shaftPower = hydraulicPower / eta;
    const differentialPressure = rho * g * H;

    if (eta < 0.45) {
      warnings.push({
        severity: 'warning',
        code: 'LOW_PUMP_EFFICIENCY',
        message: 'Pump efficiency under 45% suggests operating far from Best Efficiency Point (BEP).',
      });
    }

    return {
      ok: true,
      calculator,
      title: 'Centrifugal Pump Hydraulic & Shaft Power',
      inputs_si: {
        flow_rate: { value: Q, unit: 'm^3/s' },
        head: { value: H, unit: 'm' },
        density: { value: rho, unit: 'kg/m^3' },
        efficiency: { value: eta, unit: 'ratio' },
      },
      outputs: [
        { key: 'diff_pressure_kpa', label: 'Differential Pressure (ΔP = ρgH)', value: differentialPressure / 1000, unit: 'kPa', formatted: `${fmt(differentialPressure / 1000)} kPa`, kind: 'exact_closed_form' },
        { key: 'hydraulic_power_kw', label: 'Hydraulic Water Power (P_h)', value: hydraulicPower / 1000, unit: 'kW', formatted: `${fmt(hydraulicPower / 1000)} kW`, kind: 'exact_closed_form' },
        { key: 'shaft_power_kw', label: 'Required Brake Shaft Power (P_s = P_h / η)', value: shaftPower / 1000, unit: 'kW', formatted: `${fmt(shaftPower / 1000)} kW (${fmt(shaftPower / 745.69987)} hp)`, kind: 'exact_closed_form' },
      ],
      steps: [
        { label: 'Differential pressure across pump', formula: 'ΔP = ρ · g · H', substitution: `${rho} × 9.80665 × ${fmt(H)} m`, result: `${fmt(differentialPressure / 1000)} kPa` },
        { label: 'Fluid hydraulic power', formula: 'P_h = ΔP · Q = ρ · g · Q · H', substitution: `${fmt(differentialPressure)} Pa × ${fmt(Q)} m³/s`, result: `${fmt(hydraulicPower / 1000)} kW` },
        { label: 'Required motor/shaft power', formula: 'P_s = P_h / η', substitution: `${fmt(hydraulicPower / 1000)} kW / ${eta}`, result: `${fmt(shaftPower / 1000)} kW` },
      ],
      assumptions: ['Incompressible Newtonian liquid pump calculation at steady duty point.', 'Electric motor drive losses (η_motor) apply separately ahead of coupling shaft.'],
      limitations: ['Verify NPSHa > NPSHr + margin on suction piping separately to avoid cavitation.'],
      independent_check: {
        passed: Math.abs(differentialPressure * Q - hydraulicPower) < 1e-9,
        method: 'Hydrostatic Energy Conservation (ΔP·Q == ρgQH)',
        detail: `ΔP·Q = ${fmt(differentialPressure * Q)} W matches ρgQH = ${fmt(hydraulicPower)} W.`,
      },
      warnings,
      safety_notice: SAFETY_DISCLAIMER,
    };
  }

  if (calculator === 'gear_shaft_design') {
    const modIn = readVal('module_mm', 3, '1');
    const z1 = Math.round(Number(readVal('teeth_pinion', 20, '1').v));
    const z2 = Math.round(Number(readVal('teeth_gear', 60, '1').v));
    const tIn = readVal('torque', 180, 'N*m');
    const mIn = readVal('bending_moment', 220, 'N*m');
    const syIn = readVal('yield_strength', 310, 'MPa');
    const fosIn = readVal('target_fos', 2.0, '1');

    const moduleMm = Number(modIn.v);
    if (!Number.isFinite(moduleMm) || moduleMm <= 0) throw new Error('Metric gear module (mm) must be positive.');
    if (z1 < 12 || z2 < 12) {
      warnings.push({
        severity: 'warning',
        code: 'GEAR_UNDERCUTTING',
        message: 'Spur gears with < 17 teeth (20° pressure angle) risk involute tooth undercutting without profile shift.',
      });
    }
    const T = requireSI(tIn.v, tIn.u, 'N*m', 'Shaft Torque');
    const M = requireSI(mIn.v, mIn.u, 'N*m', 'Bending Moment');
    const Sy = posSI(syIn.v, syIn.u, 'Pa', 'Shaft Yield Strength');
    const targetFos = Number(fosIn.v);
    if (!Number.isFinite(targetFos) || targetFos <= 0) throw new Error('Target Factor of Safety must be positive.');

    const dPinionMm = moduleMm * z1;
    const dGearMm = moduleMm * z2;
    const ratio = z2 / z1;
    const centerDistMm = (moduleMm * (z1 + z2)) / 2;
    const ftPinion = Math.abs(T) > 0 ? (2 * Math.abs(T)) / (dPinionMm / 1000) : 0;

    // ASME Distortion-Energy static sizing: d^3 = (32 * n / (pi * Sy)) * sqrt(M^2 + 0.75 * T^2)
    const eqMoment = Math.sqrt(M * M + 0.75 * T * T);
    const minDiameterM = Math.cbrt(((32 * targetFos) / (Math.PI * Sy)) * eqMoment);
    const minDiameterMm = minDiameterM * 1000;

    // Independent von Mises back-substitution check using resulting diameter
    const sigmaBend = (32 * Math.abs(M)) / (Math.PI * Math.pow(minDiameterM, 3));
    const tauTorsion = (16 * Math.abs(T)) / (Math.PI * Math.pow(minDiameterM, 3));
    const sigmaVm = Math.sqrt(sigmaBend * sigmaBend + 3 * tauTorsion * tauTorsion);
    const verifiedFos = sigmaVm > 0 ? Sy / sigmaVm : targetFos;

    return {
      ok: true,
      calculator,
      title: 'Spur Gear Geometry & ASME Combined-Load Shaft Sizing',
      inputs_si: {
        module_m: { value: moduleMm / 1000, unit: 'm' },
        torque: { value: T, unit: 'N*m' },
        bending_moment: { value: M, unit: 'N*m' },
        yield_strength: { value: Sy, unit: 'Pa' },
      },
      outputs: [
        { key: 'pinion_pitch_d_mm', label: 'Pinion Pitch Diameter (d₁ = m·Z₁)', value: dPinionMm, unit: 'mm', formatted: `${fmt(dPinionMm)} mm`, kind: 'exact_closed_form' },
        { key: 'gear_pitch_d_mm', label: 'Gear Pitch Diameter (d₂ = m·Z₂)', value: dGearMm, unit: 'mm', formatted: `${fmt(dGearMm)} mm`, kind: 'exact_closed_form' },
        { key: 'gear_ratio', label: 'Transmission Ratio (i = Z₂ / Z₁)', value: ratio, unit: ': 1', formatted: `${fmt(ratio, 4)} : 1`, kind: 'exact_closed_form' },
        { key: 'center_distance_mm', label: 'Center Distance', value: centerDistMm, unit: 'mm', formatted: `${fmt(centerDistMm)} mm`, kind: 'exact_closed_form' },
        { key: 'tangential_force_n', label: 'Tangential Tooth Force (F_t)', value: ftPinion, unit: 'N', formatted: `${fmt(ftPinion)} N`, kind: 'exact_closed_form' },
        { key: 'min_shaft_diameter_mm', label: 'Min Shaft Diameter (Distortion-Energy)', value: minDiameterMm, unit: 'mm', formatted: `${fmt(minDiameterMm)} mm`, kind: 'exact_closed_form' },
      ],
      steps: [
        { label: 'Spur gear pitch diameters & center distance', formula: 'd = m·Z,  a = m(Z₁+Z₂)/2', substitution: `${moduleMm}×${z1}, ${moduleMm}×${z2}`, result: `d₁=${fmt(dPinionMm)} mm, d₂=${fmt(dGearMm)} mm, a=${fmt(centerDistMm)} mm` },
        { label: 'Equivalent ASME combined moment', formula: 'M_eq = √(M² + 0.75·T²)', substitution: `√(${fmt(M)}² + 0.75·${fmt(T)}²)`, result: `${fmt(eqMoment)} N·m` },
        { label: 'Minimum solid shaft diameter', formula: 'd = ((32·n / πSy) · M_eq)^(1/3)', substitution: `n=${targetFos}, Sy=${fmt(Sy / 1e6)} MPa`, result: `${fmt(minDiameterMm)} mm` },
      ],
      assumptions: ['Solid circular ductile steel shaft under steady bending and torque.', 'Standard full-depth involute spur gears (zero profile shift).'],
      limitations: ['Rotating fatigue life (Goodman/Soderberg endurance limit) and stress concentration fillets/keyways require additional sizing allowance.'],
      independent_check: {
        passed: Math.abs(verifiedFos - targetFos) <= 1e-4,
        method: 'Von Mises Stress Back-Substitution (Sy / √(σ_b² + 3τ²))',
        detail: `Back-substituted σ_vm = ${fmt(sigmaVm / 1e6)} MPa gives FoS = ${fmt(verifiedFos, 5)} vs target ${targetFos}.`,
      },
      warnings,
      safety_notice: SAFETY_DISCLAIMER,
    };
  }

  // Default: electrical_circuits
  const vIn = readVal('voltage', 120, 'V');
  const fIn = readVal('frequency', 60, 'Hz');
  const rIn = readVal('resistance', 24, 'ohm');
  const lIn = readVal('inductance', 20, 'mH');
  const cIn = readVal('capacitance', 100, 'uF');

  const V = posSI(vIn.v, vIn.u, 'V', 'RMS Source Voltage');
  const freq = posSI(fIn.v, fIn.u, 'Hz', 'AC Frequency');
  const R = posSI(rIn.v, rIn.u, 'ohm', 'Resistance (R)');
  const L = Math.max(0, requireSI(lIn.v, lIn.u, 'H', 'Inductance (L)'));
  const C = Math.max(0, requireSI(cIn.v, cIn.u, 'F', 'Capacitance (C)'));

  const omega = 2 * Math.PI * freq;
  const xl = omega * L;
  const xc = C > 0 ? 1 / (omega * C) : 0;
  const xNet = xl - xc;
  const zMag = Math.sqrt(R * R + xNet * xNet);
  const phaseDeg = (Math.atan2(xNet, R) * 180) / Math.PI;
  const pf = R / zMag;
  const current = V / zMag;
  const apparentPower = V * current;
  const realPower = current * current * R;
  const reactivePower = current * current * xNet;
  const fResonant = L > 0 && C > 0 ? 1 / (2 * Math.PI * Math.sqrt(L * C)) : 0;

  // Independent power triangle identity check: S^2 == P^2 + Q^2
  const sRebuilt = Math.sqrt(realPower * realPower + reactivePower * reactivePower);

  if (current > 15) {
    warnings.push({
      severity: 'warning',
      code: 'HIGH_BRANCH_CURRENT',
      message: `Current (${fmt(current)} A) requires wire gauge ampacity & breaker verification.`,
    });
  }

  return {
    ok: true,
    calculator: 'electrical_circuits',
    title: 'AC Series RLC Impedance, Resonance & Power Factor',
    inputs_si: {
      voltage: { value: V, unit: 'V' },
      frequency: { value: freq, unit: 'Hz' },
      resistance: { value: R, unit: 'ohm' },
      inductance: { value: L, unit: 'H' },
      capacitance: { value: C, unit: 'F' },
    },
    outputs: [
      { key: 'impedance_ohm', label: 'Total Impedance |Z|', value: zMag, unit: 'Ω', formatted: `${fmt(zMag)} Ω ∠ ${fmt(phaseDeg, 4)}°`, kind: 'exact_closed_form' },
      { key: 'current_a', label: 'RMS Current (I = V / |Z|)', value: current, unit: 'A', formatted: `${fmt(current)} A`, kind: 'exact_closed_form' },
      { key: 'power_factor', label: 'Power Factor (cos φ)', value: pf, unit: xNet >= 0 ? 'lagging' : 'leading', formatted: `${fmt(pf, 4)} (${xNet >= 0 ? 'lagging' : 'leading'})`, kind: 'exact_closed_form' },
      { key: 'real_power_w', label: 'Active Power (P = I²R)', value: realPower, unit: 'W', formatted: `${fmt(realPower)} W`, kind: 'exact_closed_form' },
      { key: 'resonant_hz', label: 'Resonant Frequency (f₀)', value: fResonant, unit: 'Hz', formatted: fResonant > 0 ? `${fmt(fResonant)} Hz` : 'n/a (L or C = 0)', kind: 'exact_closed_form' },
    ],
    steps: [
      { label: 'Inductive & capacitive reactances', formula: 'X_L = 2πfL,  X_C = 1/(2πfC)', substitution: `X_L=${fmt(xl)} Ω, X_C=${fmt(xc)} Ω`, result: `X_net = ${fmt(xNet)} Ω` },
      { label: 'Phasor impedance & current', formula: '|Z| = √(R² + X_net²),  I = V/|Z|', substitution: `√(${R}² + ${fmt(xNet)}²)`, result: `|Z|=${fmt(zMag)} Ω, I=${fmt(current)} A` },
      { label: 'Active power & power factor', formula: 'P = I²R,  PF = R/|Z|', substitution: `${fmt(current)}² × ${R}`, result: `P=${fmt(realPower)} W, PF=${fmt(pf, 4)}` },
    ],
    assumptions: ['Pure sinusoidal steady-state AC excitation at frequency f.', 'Linear lumped R, L, C elements (zero core saturation or ESR/ESL parasitism).'],
    limitations: ['Switch-mode converters and non-linear loads introduce harmonics omitted here.'],
    independent_check: {
      passed: Math.abs(apparentPower - sRebuilt) <= Math.max(1e-7, apparentPower * 1e-9),
      method: 'AC Power Triangle Identity (V·I == √(P² + Q²))',
      detail: `S = V·I = ${fmt(apparentPower)} VA vs √(P²+Q²) = ${fmt(sRebuilt)} VA.`,
    },
    warnings,
    safety_notice: SAFETY_DISCLAIMER,
  };
}
