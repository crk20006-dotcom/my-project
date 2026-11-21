import { all, create } from 'mathjs';
import type { MathComputationResult, MathOperationType, PlotChartSpec } from './interfaces.ts';

const math = create(all, {});

const BLOCKED_EXPR_PATTERN = /\b(import|evaluate|parse|createUnit|simplifyCore)\b|__|\[['"`]/;

function assertSafeMathExpression(expr: string, label = 'Expression'): string {
  const trimmed = String(expr || '').trim();
  if (!trimmed || trimmed.length > 400) {
    throw new Error(`${label} must be 1 to 400 characters.`);
  }
  if (BLOCKED_EXPR_PATTERN.test(trimmed)) {
    throw new Error(`${label} contains restricted syntax.`);
  }
  return trimmed;
}

function buildChartBounds(seriesList: Array<{ points: Array<{ x: number; y: number }> }>): {
  x_min: number;
  x_max: number;
  y_min: number;
  y_max: number;
} {
  let xMin = Infinity;
  let xMax = -Infinity;
  let yMin = Infinity;
  let yMax = -Infinity;

  for (const s of seriesList) {
    for (const pt of s.points) {
      if (Number.isFinite(pt.x) && Number.isFinite(pt.y)) {
        if (pt.x < xMin) xMin = pt.x;
        if (pt.x > xMax) xMax = pt.x;
        if (pt.y < yMin) yMin = pt.y;
        if (pt.y > yMax) yMax = pt.y;
      }
    }
  }

  if (!Number.isFinite(xMin) || !Number.isFinite(yMin)) {
    return { x_min: 0, x_max: 1, y_min: 0, y_max: 1 };
  }
  if (xMin === xMax) {
    xMin -= 1;
    xMax += 1;
  }
  if (yMin === yMax) {
    const pad = Math.max(0.5, Math.abs(yMin) * 0.2);
    yMin -= pad;
    yMax += pad;
  } else {
    const yPad = (yMax - yMin) * 0.08;
    yMin -= yPad;
    yMax += yPad;
  }
  return { x_min: xMin, x_max: xMax, y_min: yMin, y_max: yMax };
}

function sampleExpressionCurve(
  compiled: { evaluate: (scope: Record<string, number>) => unknown },
  varName: string,
  xStart: number,
  xEnd: number,
  pointsCount = 90
): Array<{ x: number; y: number }> {
  const pts: Array<{ x: number; y: number }> = [];
  const steps = Math.max(12, Math.min(200, pointsCount));
  for (let i = 0; i <= steps; i += 1) {
    const x = xStart + ((xEnd - xStart) * i) / steps;
    try {
      const y = Number(compiled.evaluate({ [varName]: x }));
      if (Number.isFinite(y) && Math.abs(y) < 1e9) {
        pts.push({ x: Number(x.toFixed(6)), y: Number(y.toFixed(6)) });
      }
    } catch {
      // Skip pole/asymptote point cleanly
    }
  }
  return pts;
}

export function runMathComputation(
  operation: MathOperationType,
  params: Record<string, unknown>
): MathComputationResult {
  const warnings: string[] = [];

  if (operation === 'evaluate') {
    const expr = assertSafeMathExpression(String(params.expression || ''));
    const scopeInput = (params.variables && typeof params.variables === 'object' ? params.variables : {}) as Record<string, number>;
    const cleanScope: Record<string, number> = {};
    for (const [k, v] of Object.entries(scopeInput)) {
      if (/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(k) && Number.isFinite(Number(v))) {
        cleanScope[k] = Number(v);
      }
    }

    const compiled = math.compile(expr);
    const val = compiled.evaluate(cleanScope);
    let simplified = '';
    try {
      simplified = math.simplify(expr).toString();
    } catch {
      simplified = expr;
    }

    let chart: PlotChartSpec | undefined;
    if (params.plot_var && typeof params.plot_var === 'string') {
      const pv = params.plot_var.trim();
      const xMin = Number(params.x_min ?? -5);
      const xMax = Number(params.x_max ?? 5);
      if (Number.isFinite(xMin) && Number.isFinite(xMax) && xMax > xMin) {
        const pts = sampleExpressionCurve(compiled, pv, xMin, xMax, 80);
        if (pts.length >= 2) {
          const bounds = buildChartBounds([{ points: pts }]);
          chart = {
            title: `f(${pv}) = ${expr}`,
            x_label: pv,
            y_label: `f(${pv})`,
            ...bounds,
            series: [{ id: 'fx', label: `f(${pv})`, color: '#38bdf8', points: pts }],
          };
        }
      }
    }

    const formattedVal = typeof val === 'number' ? Number(val.toPrecision(10)) : math.format(val, { precision: 10 });
    return {
      ok: true,
      operation,
      summary: `${expr} = ${formattedVal}`,
      result_value: formattedVal,
      steps: [
        `Parsed expression: ${expr}`,
        `Symbolic simplified form: ${simplified}`,
        Object.keys(cleanScope).length > 0
          ? `Substituted scope: ${JSON.stringify(cleanScope)}`
          : 'Evaluated constant/symbolic expression directly.',
        `Computed result: ${formattedVal}`,
      ],
      warnings,
      chart,
    };
  }

  if (operation === 'derivative') {
    const expr = assertSafeMathExpression(String(params.expression || ''));
    const variable = String(params.variable || 'x').trim();
    if (!/^[a-zA-Z]$/.test(variable)) {
      throw new Error('Differentiation variable must be a single letter (e.g. x, t).');
    }

    const derivNode = math.derivative(expr, variable);
    const simplifiedDeriv = math.simplify(derivNode).toString();
    const hasPoint = params.at !== undefined && params.at !== '' && Number.isFinite(Number(params.at));
    const atVal = hasPoint ? Number(params.at) : null;

    let slopeAtPoint: number | null = null;
    let verification: MathComputationResult['verification'] | undefined;
    const fCompiled = math.compile(expr);
    const dfCompiled = derivNode.compile();

    if (atVal !== null) {
      slopeAtPoint = Number(dfCompiled.evaluate({ [variable]: atVal }));
      const h = 1e-6;
      const centralDiff =
        (Number(fCompiled.evaluate({ [variable]: atVal + h })) -
          Number(fCompiled.evaluate({ [variable]: atVal - h }))) /
        (2 * h);
      const err = Math.abs(slopeAtPoint - centralDiff);
      verification = {
        passed: err <= Math.max(1e-5, Math.abs(slopeAtPoint) * 1e-5),
        method: 'Central Finite-Difference Check (h = 1e-6)',
        residual: Number(err.toExponential(3)),
        detail: `Symbolic f'(${atVal}) = ${Number(slopeAtPoint.toPrecision(8))} vs numeric CD = ${Number(centralDiff.toPrecision(8))}.`,
      };
    }

    const xMin = atVal !== null ? atVal - 5 : -5;
    const xMax = atVal !== null ? atVal + 5 : 5;
    const fxPts = sampleExpressionCurve(fCompiled, variable, xMin, xMax, 80);
    const dfPts = sampleExpressionCurve(dfCompiled, variable, xMin, xMax, 80);
    const bounds = buildChartBounds([{ points: fxPts }, { points: dfPts }]);

    return {
      ok: true,
      operation,
      summary: `d/d${variable} (${expr}) = ${simplifiedDeriv}`,
      result_value: atVal !== null ? { symbolic: simplifiedDeriv, value_at_point: slopeAtPoint, at: atVal } : simplifiedDeriv,
      steps: [
        `Original function: f(${variable}) = ${expr}`,
        `Symbolic differentiation: f'(${variable}) = ${derivNode.toString()}`,
        `Simplified form: ${simplifiedDeriv}`,
        ...(atVal !== null ? [`Evaluated at ${variable} = ${atVal}: f'(${atVal}) = ${slopeAtPoint}`] : []),
      ],
      verification,
      warnings,
      chart: {
        title: `Function vs Derivative (d/d${variable})`,
        x_label: variable,
        y_label: 'value',
        ...bounds,
        series: [
          { id: 'f', label: `f(${variable})`, color: '#38bdf8', points: fxPts },
          { id: 'df', label: `f'(${variable})`, color: '#f59e0b', points: dfPts },
        ],
      },
    };
  }

  if (operation === 'integral') {
    const expr = assertSafeMathExpression(String(params.expression || ''));
    const variable = String(params.variable || 'x').trim();
    const a = Number(params.lower ?? 0);
    const b = Number(params.upper ?? 1);
    const nRaw = Math.round(Number(params.intervals ?? 200));
    const n = Math.max(10, Math.min(2000, nRaw % 2 === 0 ? nRaw : nRaw + 1));

    if (!Number.isFinite(a) || !Number.isFinite(b) || a === b) {
      throw new Error('Lower and upper integration bounds must be distinct finite numbers.');
    }

    const compiled = math.compile(expr);
    const simpson = (steps: number) => {
      const h = (b - a) / steps;
      let sum = Number(compiled.evaluate({ [variable]: a })) + Number(compiled.evaluate({ [variable]: b }));
      for (let i = 1; i < steps; i += 1) {
        const x = a + i * h;
        const y = Number(compiled.evaluate({ [variable]: x }));
        if (!Number.isFinite(y)) throw new Error(`Integrand is undefined or singular near ${variable} = ${x}.`);
        sum += (i % 2 === 0 ? 2 : 4) * y;
      }
      return (sum * h) / 3;
    };

    const integralN = simpson(n);
    const integral2N = simpson(n * 2);
    const richardsonDiff = Math.abs(integral2N - integralN) / 15;

    if (richardsonDiff > Math.max(1e-3, Math.abs(integral2N) * 1e-2)) {
      warnings.push(`Step-doubling error estimate (${richardsonDiff.toExponential(2)}) is elevated; integrand may oscillate rapidly.`);
    }

    const pts = sampleExpressionCurve(compiled, variable, Math.min(a, b), Math.max(a, b), 80);
    const bounds = buildChartBounds([{ points: pts }]);

    return {
      ok: true,
      operation,
      summary: `∫_${a}^${b} (${expr}) d${variable} ≈ ${Number(integral2N.toPrecision(9))}`,
      result_value: Number(integral2N.toPrecision(10)),
      steps: [
        `Composite Simpson’s Rule on [${a}, ${b}] with N=${n} vs 2N=${n * 2} sub-intervals`,
        `S(${n}) = ${Number(integralN.toPrecision(10))}`,
        `S(${n * 2}) = ${Number(integral2N.toPrecision(10))}`,
        `Richardson convergence bound |Δ|/15 ≈ ${richardsonDiff.toExponential(3)}`,
      ],
      verification: {
        passed: richardsonDiff <= Math.max(1e-4, Math.abs(integral2N) * 1e-3),
        method: `Composite Simpson Richardson Estimate (N=${n} vs 2N=${n * 2})`,
        residual: Number(richardsonDiff.toExponential(3)),
        detail: `Estimated quadrature error ≈ ${richardsonDiff.toExponential(3)}.`,
      },
      warnings,
      chart: {
        title: `Definite Integral Area [${a}, ${b}]`,
        x_label: variable,
        y_label: `f(${variable})`,
        ...bounds,
        series: [{ id: 'integrand', label: `f(${variable})`, color: '#10b981', points: pts }],
      },
    };
  }

  if (operation === 'matrix_solve') {
    const A = params.A as number[][];
    const b = params.b as number[];
    if (!Array.isArray(A) || A.length === 0 || !Array.isArray(b) || b.length !== A.length) {
      throw new Error('Matrix A (n×n) and vector b (length n) are required.');
    }
    const n = A.length;
    if (n > 20 || !A.every((row) => Array.isArray(row) && row.length === n && row.every((c) => Number.isFinite(Number(c))))) {
      throw new Error('Matrix A must be a finite square matrix up to 20×20.');
    }
    const numA = A.map((r) => r.map(Number));
    const numB = b.map(Number);

    const detA = Number(math.det(numA));
    if (Math.abs(detA) < 1e-12) {
      throw new Error(`Matrix A is singular or near-singular (det = ${detA.toExponential(3)}); no unique solution exists.`);
    }

    const solRaw = math.lusolve(numA, numB) as number[][] | number[];
    const xVec = Array.isArray(solRaw[0])
      ? (solRaw as number[][]).map((row) => Number(row[0]))
      : (solRaw as number[]).map(Number);

    // Independent residual check ||A*x - b||_inf
    const ax = math.multiply(numA, xVec) as number[];
    let maxResidual = 0;
    for (let i = 0; i < n; i += 1) {
      maxResidual = Math.max(maxResidual, Math.abs(ax[i] - numB[i]));
    }

    return {
      ok: true,
      operation,
      summary: `Solved ${n}×${n} linear system A·x = b (max residual ${maxResidual.toExponential(2)})`,
      result_value: {
        solution_x: xVec.map((v) => Number(v.toPrecision(10))),
        determinant: Number(detA.toPrecision(8)),
      },
      steps: [
        `Matrix dimension: ${n}×${n}, det(A) = ${Number(detA.toPrecision(6))}`,
        'Applied LU decomposition with partial pivoting (math.lusolve).',
        `Solution vector x = [${xVec.map((v) => Number(v.toPrecision(7))).join(', ')}]`,
      ],
      verification: {
        passed: maxResidual <= 1e-7,
        method: 'Back-Substitution Infinity Residual ||A·x - b||∞',
        residual: Number(maxResidual.toExponential(3)),
        detail: `Max equation residual across ${n} rows is ${maxResidual.toExponential(3)}.`,
      },
      warnings,
    };
  }

  if (operation === 'matrix_analyze') {
    const A = params.A as number[][];
    if (!Array.isArray(A) || A.length === 0 || A.length > 15) {
      throw new Error('Square matrix A (1×1 to 15×15) is required.');
    }
    const n = A.length;
    if (!A.every((row) => Array.isArray(row) && row.length === n)) {
      throw new Error('Matrix A must be square.');
    }
    const numA = A.map((r) => r.map(Number));
    const det = Number(math.det(numA));
    const trace = numA.reduce((acc, row, idx) => acc + row[idx], 0);
    let inverse: number[][] | null = null;
    if (Math.abs(det) > 1e-12) {
      inverse = (math.inv(numA) as number[][]).map((row) => row.map((v) => Number(v.toPrecision(7))));
    } else {
      warnings.push('Determinant is ~0; matrix is singular and has no inverse.');
    }

    let eigenvalues: Array<string | number> = [];
    try {
      const eig = math.eigs(numA) as { values?: unknown };
      const vals = (eig.values as { toArray?: () => unknown[] } | unknown[]) || [];
      const arr = Array.isArray(vals) ? vals : typeof vals.toArray === 'function' ? vals.toArray() : [];
      eigenvalues = arr.map((v) =>
        typeof v === 'number' ? Number(v.toPrecision(7)) : math.format(v, { precision: 6 })
      );
    } catch {
      warnings.push('Eigenvalue solver unavailable for non-convergent defective matrix.');
    }

    return {
      ok: true,
      operation,
      summary: `${n}×${n} Matrix Analysis: det = ${Number(det.toPrecision(6))}, trace = ${Number(trace.toPrecision(6))}`,
      result_value: { determinant: det, trace, eigenvalues, inverse },
      steps: [
        `Evaluated det(A) = ${Number(det.toPrecision(8))}`,
        `Evaluated trace(A) = ${Number(trace.toPrecision(8))}`,
        ...(eigenvalues.length ? [`Eigenvalues λ = [${eigenvalues.join(', ')}]`] : []),
      ],
      warnings,
    };
  }

  if (operation === 'ode_rk4') {
    // 1st order dy/dt = f(t, y)
    const rhsExpr = assertSafeMathExpression(String(params.rhs || '-0.5 * y'));
    const t0 = Number(params.t0 ?? 0);
    const y0 = Number(params.y0 ?? 1);
    const tEnd = Number(params.t_end ?? 10);
    const stepsCount = Math.max(10, Math.min(800, Math.round(Number(params.steps ?? 100))));

    if (!Number.isFinite(t0) || !Number.isFinite(y0) || !Number.isFinite(tEnd) || tEnd <= t0) {
      throw new Error('ODE requires finite t0 < t_end and finite y0.');
    }

    const compiled = math.compile(rhsExpr);
    const solveRk4 = (steps: number) => {
      const h = (tEnd - t0) / steps;
      let t = t0;
      let y = y0;
      const pts = [{ x: t, y }];
      for (let i = 0; i < steps; i += 1) {
        const k1 = Number(compiled.evaluate({ t, y }));
        const k2 = Number(compiled.evaluate({ t: t + 0.5 * h, y: y + 0.5 * h * k1 }));
        const k3 = Number(compiled.evaluate({ t: t + 0.5 * h, y: y + 0.5 * h * k2 }));
        const k4 = Number(compiled.evaluate({ t: t + h, y: y + h * k3 }));
        y = y + (h / 6) * (k1 + 2 * k2 + 2 * k3 + k4);
        t = t + h;
        if (!Number.isFinite(y) || Math.abs(y) > 1e12) {
          throw new Error(`ODE solution diverged or became unstable around t = ${t.toFixed(3)}.`);
        }
        pts.push({ x: Number(t.toFixed(6)), y: Number(y.toFixed(6)) });
      }
      return pts;
    };

    const ptsPrimary = solveRk4(stepsCount);
    const ptsFine = solveRk4(stepsCount * 2);
    const finalPrimary = ptsPrimary[ptsPrimary.length - 1].y;
    const finalFine = ptsFine[ptsFine.length - 1].y;
    const convergenceDiff = Math.abs(finalFine - finalPrimary);

    const bounds = buildChartBounds([{ points: ptsPrimary }]);

    return {
      ok: true,
      operation,
      summary: `RK4 ODE solved on [${t0}, ${tEnd}]: y(${tEnd}) = ${Number(finalFine.toPrecision(8))}`,
      result_value: {
        y_end: Number(finalFine.toPrecision(10)),
        step_size_h: Number(((tEnd - t0) / stepsCount).toPrecision(5)),
        sample_count: ptsPrimary.length,
      },
      steps: [
        `Solved IVP dy/dt = ${rhsExpr} with y(${t0}) = ${y0}`,
        `Primary RK4 (${stepsCount} steps): y(${tEnd}) = ${Number(finalPrimary.toPrecision(9))}`,
        `Refined RK4 (${stepsCount * 2} steps): y(${tEnd}) = ${Number(finalFine.toPrecision(9))}`,
      ],
      verification: {
        passed: convergenceDiff <= Math.max(1e-4, Math.abs(finalFine) * 1e-3),
        method: `RK4 Step-Halving Convergence Check (${stepsCount} vs ${stepsCount * 2} steps)`,
        residual: Number(convergenceDiff.toExponential(3)),
        detail: `Terminal value shift between h and h/2 is ${convergenceDiff.toExponential(3)}.`,
      },
      warnings,
      chart: {
        title: `ODE Solution y(t): dy/dt = ${rhsExpr}`,
        x_label: 't',
        y_label: 'y(t)',
        ...bounds,
        series: [{ id: 'ode', label: 'y(t)', color: '#60a5fa', points: ptsPrimary }],
      },
    };
  }

  if (operation === 'root_find') {
    const expr = assertSafeMathExpression(String(params.expression || 'x^3 - 2*x - 5'));
    const variable = String(params.variable || 'x').trim();
    const xLowInit = Number(params.x_low ?? 1);
    const xHighInit = Number(params.x_high ?? 3);

    const fNode = math.parse(expr);
    const dfNode = math.derivative(fNode, variable);
    const fEval = fNode.compile();
    const dfEval = dfNode.compile();

    const evalF = (v: number) => Number(fEval.evaluate({ [variable]: v }));
    const evalDf = (v: number) => Number(dfEval.evaluate({ [variable]: v }));

    let a = xLowInit;
    let b = xHighInit;
    let fa = evalF(a);
    let fb = evalF(b);
    let root = (a + b) / 2;
    let methodUsed = 'Newton-Raphson';
    const trace: string[] = [];

    if (fa * fb <= 0) {
      methodUsed = 'Bisection (Bracketed) + Newton-Raphson Refinement';
      for (let i = 0; i < 40; i += 1) {
        const mid = (a + b) / 2;
        const fmid = evalF(mid);
        if (Math.abs(fmid) < 1e-11 || Math.abs(b - a) < 1e-11) {
          root = mid;
          break;
        }
        if (fa * fmid <= 0) {
          b = mid;
          fb = fmid;
        } else {
          a = mid;
          fa = fmid;
        }
        root = mid;
      }
      trace.push(`Bisection converged bracket to ${root.toPrecision(8)}`);
    } else {
      warnings.push('Initial interval [x_low, x_high] did not bracket a sign change; using Newton-Raphson from midpoint.');
    }

    // Newton-Raphson polish
    for (let iter = 1; iter <= 15; iter += 1) {
      const fx = evalF(root);
      const dfx = evalDf(root);
      if (Math.abs(fx) < 1e-12) break;
      if (Math.abs(dfx) < 1e-12) break;
      root = root - fx / dfx;
    }

    const residual = Math.abs(evalF(root));
    const span = Math.max(2, Math.abs(xHighInit - xLowInit));
    const pts = sampleExpressionCurve(fEval, variable, root - span, root + span, 80);
    const bounds = buildChartBounds([{ points: pts }]);

    return {
      ok: true,
      operation,
      summary: `Root found: ${variable} ≈ ${Number(root.toPrecision(10))} (|f(${variable})| = ${residual.toExponential(2)})`,
      result_value: Number(root.toPrecision(10)),
      steps: [
        `Target equation: f(${variable}) = ${expr} = 0`,
        `Symbolic derivative used for Newton polish: f'(${variable}) = ${dfNode.toString()}`,
        `Method: ${methodUsed}`,
        ...trace,
        `Final root ${variable} = ${Number(root.toPrecision(10))}`,
      ],
      verification: {
        passed: residual <= 1e-7,
        method: 'Direct Function Evaluation Residual |f(root)|',
        residual: Number(residual.toExponential(3)),
        detail: `f(${Number(root.toPrecision(8))}) = ${residual.toExponential(3)}.`,
      },
      warnings,
      chart: {
        title: `Root Location of f(${variable}) = 0`,
        x_label: variable,
        y_label: `f(${variable})`,
        ...bounds,
        series: [{ id: 'curve', label: `f(${variable})`, color: '#a78bfa', points: pts }],
        markers: [{ x: root, y: 0, label: `Root ≈ ${Number(root.toPrecision(5))}`, color: '#34d399' }],
      },
    };
  }

  // statistics_regression
  const rawPoints = Array.isArray(params.points)
    ? (params.points as Array<{ x: number; y: number }>).filter((p) => Number.isFinite(Number(p.x)) && Number.isFinite(Number(p.y)))
    : [];
  const rawValues = Array.isArray(params.values)
    ? (params.values as number[]).map(Number).filter(Number.isFinite)
    : [];

  if (rawPoints.length >= 2) {
    const n = rawPoints.length;
    const xs = rawPoints.map((p) => Number(p.x));
    const ys = rawPoints.map((p) => Number(p.y));
    const meanX = xs.reduce((a, b) => a + b, 0) / n;
    const meanY = ys.reduce((a, b) => a + b, 0) / n;

    let sxx = 0;
    let sxy = 0;
    let syy = 0;
    for (let i = 0; i < n; i += 1) {
      const dx = xs[i] - meanX;
      const dy = ys[i] - meanY;
      sxx += dx * dx;
      sxy += dx * dy;
      syy += dy * dy;
    }
    if (sxx === 0) throw new Error('All x values are identical; cannot fit linear slope.');
    const slope = sxy / sxx;
    const intercept = meanY - slope * meanX;
    let ssRes = 0;
    for (let i = 0; i < n; i += 1) {
      const pred = slope * xs[i] + intercept;
      ssRes += (ys[i] - pred) * (ys[i] - pred);
    }
    const rSquared = syy > 0 ? 1 - ssRes / syy : 1;
    const rmse = Math.sqrt(ssRes / n);

    const minX = Math.min(...xs);
    const maxX = Math.max(...xs);
    const linePts = [
      { x: minX, y: slope * minX + intercept },
      { x: maxX, y: slope * maxX + intercept },
    ];
    const bounds = buildChartBounds([{ points: rawPoints }, { points: linePts }]);

    return {
      ok: true,
      operation,
      summary: `OLS Linear Fit (n=${n}): y = ${Number(slope.toPrecision(5))}x + ${Number(intercept.toPrecision(5))} (R² = ${rSquared.toFixed(5)})`,
      result_value: {
        n,
        slope: Number(slope.toPrecision(8)),
        intercept: Number(intercept.toPrecision(8)),
        r_squared: Number(rSquared.toFixed(6)),
        rmse: Number(rmse.toPrecision(6)),
        mean_y: Number(meanY.toPrecision(7)),
      },
      steps: [
        `Sample count n = ${n}, mean(x) = ${Number(meanX.toPrecision(6))}, mean(y) = ${Number(meanY.toPrecision(6))}`,
        `Slope m = Sxy / Sxx = ${Number(slope.toPrecision(7))}`,
        `Intercept b = mean(y) - m·mean(x) = ${Number(intercept.toPrecision(7))}`,
        `Goodness of fit R² = ${rSquared.toFixed(6)}, RMSE = ${Number(rmse.toPrecision(6))}`,
      ],
      warnings,
      chart: {
        title: `Linear Regression (R² = ${rSquared.toFixed(4)})`,
        x_label: 'x',
        y_label: 'y',
        ...bounds,
        series: [
          { id: 'fit', label: 'Linear Fit', color: '#38bdf8', points: linePts },
          { id: 'data', label: 'Measured Data', color: '#f59e0b', points: rawPoints },
        ],
      },
    };
  }

  if (rawValues.length < 2) {
    throw new Error('Provide at least 2 numeric values or 2 (x, y) data points.');
  }

  const sorted = [...rawValues].sort((a, b) => a - b);
  const n = sorted.length;
  const mean = sorted.reduce((a, b) => a + b, 0) / n;
  const varianceSample = sorted.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1);
  const stdSample = Math.sqrt(varianceSample);
  const stdError = stdSample / Math.sqrt(n);
  const median = n % 2 === 1 ? sorted[(n - 1) / 2] : (sorted[n / 2 - 1] + sorted[n / 2]) / 2;

  return {
    ok: true,
    operation,
    summary: `Sample stats (n=${n}): mean = ${Number(mean.toPrecision(7))}, SD = ${Number(stdSample.toPrecision(6))}`,
    result_value: {
      n,
      mean: Number(mean.toPrecision(8)),
      median: Number(median.toPrecision(8)),
      sample_stddev: Number(stdSample.toPrecision(8)),
      sample_variance: Number(varianceSample.toPrecision(8)),
      min: sorted[0],
      max: sorted[n - 1],
      ci_95_approx: [
        Number((mean - 1.96 * stdError).toPrecision(7)),
        Number((mean + 1.96 * stdError).toPrecision(7)),
      ],
    },
    steps: [
      `Sorted ${n} values: min=${sorted[0]}, median=${median}, max=${sorted[n - 1]}`,
      `Sample mean μ̂ = ${Number(mean.toPrecision(8))}`,
      `Sample standard deviation s = ${Number(stdSample.toPrecision(8))} (Bessel N-1 denominator)`,
    ],
    warnings,
  };
}
