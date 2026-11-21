import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type {
  PlotChartSpec,
  SimulationExecutionResult,
  SimulationToolAdapter,
  SimulationToolDescriptor,
} from './interfaces.ts';

const execFileAsync = promisify(execFile);

export interface PythonSimulationPreset {
  id: string;
  title: string;
  description: string;
  code: string;
}

export const PYTHON_SIMULATION_PRESETS: PythonSimulationPreset[] = [
  {
    id: 'damped_oscillator',
    title: 'Damped Harmonic Oscillator (RK4 Pure Python)',
    description: 'Solves m·ẍ + c·ẋ + k·x = 0 via 4th-order Runge-Kutta without third-party dependencies and outputs JSON curve points.',
    code: `import json, math

m, c, k = 1.5, 1.2, 24.0
dt, steps = 0.04, 100
x, v, t = 1.0, 0.0, 0.0
points = []

def deriv(x_val, v_val):
    return v_val, -(c / m) * v_val - (k / m) * x_val

for _ in range(steps + 1):
    points.append({"x": round(t, 4), "y": round(x, 6)})
    k1x, k1v = deriv(x, v)
    k2x, k2v = deriv(x + 0.5*dt*k1x, v + 0.5*dt*k1v)
    k3x, k3v = deriv(x + 0.5*dt*k2x, v + 0.5*dt*k2v)
    k4x, k4v = deriv(x + dt*k3x, v + dt*k3v)
    x += (dt / 6.0) * (k1x + 2*k2x + 2*k3x + k4x)
    v += (dt / 6.0) * (k1v + 2*k2v + 2*k3v + k4v)
    t += dt

zeta = c / (2 * math.sqrt(k * m))
print(json.dumps({
    "summary": f"Damping ratio zeta={zeta:.4f}, final x={x:.5f}",
    "x_label": "Time (s)",
    "y_label": "Displacement x(t)",
    "series_label": "Damped Response",
    "points": points
}))`,
  },
  {
    id: 'heat_conduction_1d',
    title: '1D Transient Heat Conduction (Explicit Finite-Difference)',
    description: 'Computes 1D rod temperature profile across 20 spatial nodes and exports temperature distribution.',
    code: `import json

alpha = 0.00011  # Copper thermal diffusivity ~1.1e-4 m^2/s
L = 0.5
N = 20
dx = L / N
dt = 0.25 * dx * dx / alpha  # Stability criterion r = 0.25 <= 0.5
T = [25.0] * (N + 1)
T[0] = 120.0
T[N] = 25.0

for _ in range(180):
    T_next = list(T)
    for i in range(1, N):
        T_next[i] = T[i] + 0.25 * (T[i+1] - 2*T[i] + T[i-1])
    T = T_next

points = [{"x": round(i * dx * 1000, 1), "y": round(T[i], 3)} for i in range(N + 1)]
print(json.dumps({
    "summary": f"Copper rod midpoint T={T[N//2]:.2f} C after 180 explicit FD steps",
    "x_label": "Position x (mm)",
    "y_label": "Temperature (C)",
    "series_label": "Rod Temperature Profile",
    "points": points
}))`,
  },
  {
    id: 'monte_carlo_tolerance',
    title: 'Monte Carlo Tolerance Stack-Up Analysis (3 Parts)',
    description: 'Simulates 3,000 random assemblies across Gaussian part tolerances to verify clearance failure rate.',
    code: `import json, random, statistics

random.seed(42)
samples = []
out_of_spec = 0
for _ in range(3000):
    hole = random.gauss(25.012, 0.005)
    shaft = random.gauss(24.985, 0.004)
    clearance = hole - shaft
    samples.append(clearance)
    if clearance < 0.005:
        out_of_spec += 1

print(json.dumps({
    "summary": f"Mean clearance={statistics.mean(samples)*1000:.2f} um, sigma={statistics.stdev(samples)*1000:.2f} um, reject_rate={out_of_spec/30:.2f}%",
    "mean_mm": round(statistics.mean(samples), 5),
    "stdev_mm": round(statistics.stdev(samples), 5),
    "reject_count": out_of_spec
}))`,
  },
];

const BLOCKED_PYTHON_TOKENS =
  /\b(__import__|open|exec|eval|compile|input|breakpoint|getattr|setattr|delattr|globals|locals|vars|dir|os|sys|subprocess|socket|http|urllib|pathlib|shutil|importlib|ctypes|multiprocessing|threading|pty)\b/;

export class LocalPythonSimulationAdapter implements SimulationToolAdapter {
  readonly id = 'local_python_scientific';

  private getPythonCommand(): string {
    return process.platform === 'win32' ? 'python' : 'python3';
  }

  async probeCapabilities(): Promise<SimulationToolDescriptor[]> {
    const pyCmd = this.getPythonCommand();
    try {
      const { stdout } = await execFileAsync(
        pyCmd,
        [
          '-I',
          '-c',
          'import sys, importlib.util, json; print(json.dumps({"version": sys.version.split()[0], "numpy": importlib.util.find_spec("numpy") is not None, "scipy": importlib.util.find_spec("scipy") is not None, "sympy": importlib.util.find_spec("sympy") is not None, "matplotlib": importlib.util.find_spec("matplotlib") is not None}))',
        ],
        { timeout: 3000, maxBuffer: 64 * 1024 }
      );
      const info = JSON.parse(stdout.trim()) as {
        version: string;
        numpy: boolean;
        scipy: boolean;
        sympy: boolean;
        matplotlib: boolean;
      };
      return [
        {
          id: 'python_stdlib',
          name: 'Python Standard Scientific Runtime (math, cmath, statistics, decimal)',
          runtime: 'python3 -I',
          available: true,
          version: info.version,
          status_note: `Operational locally (Python ${info.version}) with AST sandbox and 4s CPU cap.`,
        },
        {
          id: 'numpy',
          name: 'NumPy Array & Linear Algebra Engine',
          runtime: 'python3 module',
          available: info.numpy,
          version: info.numpy ? 'installed' : null,
          status_note: info.numpy ? 'Detected on local Python environment.' : 'Not installed in current container (optional: pip install numpy).',
        },
        {
          id: 'scipy',
          name: 'SciPy Optimization & ODE Solvers',
          runtime: 'python3 module',
          available: info.scipy,
          version: info.scipy ? 'installed' : null,
          status_note: info.scipy ? 'Detected on local Python environment.' : 'Not installed in current container (optional: pip install scipy).',
        },
        {
          id: 'sympy',
          name: 'SymPy Symbolic Mathematics',
          runtime: 'python3 module',
          available: info.sympy,
          version: info.sympy ? 'installed' : null,
          status_note: info.sympy ? 'Detected on local Python environment.' : 'Not installed (mathjs symbolic differentiation active in Node).',
        },
        {
          id: 'matplotlib',
          name: 'Matplotlib Scientific Plotting',
          runtime: 'python3 module',
          available: info.matplotlib,
          version: info.matplotlib ? 'installed' : null,
          status_note: info.matplotlib ? 'Detected on local Python environment.' : 'Not installed (native interactive SVG charts active in UI).',
        },
      ];
    } catch {
      return [
        {
          id: 'python_stdlib',
          name: 'Python Scientific Runtime',
          runtime: 'python',
          available: false,
          version: null,
          status_note: 'Python binary not detected on PATH; built-in TypeScript/MathJS solvers remain operational.',
        },
      ];
    }
  }

  async runRestrictedScript(
    code: string,
    approved: boolean,
    timeoutMs = 4000
  ): Promise<SimulationExecutionResult> {
    const cleanCode = String(code || '').trim();
    const boundedTimeout = Math.min(5000, Math.max(500, Math.round(timeoutMs)));
    const limits = {
      timeout_ms: boundedTimeout,
      max_stdout_bytes: 16 * 1024,
      isolated_mode: true,
    };

    if (!approved) {
      throw new Error('Explicit user approval (approved: true) is required before executing local Python scientific code.');
    }
    if (!cleanCode || cleanCode.length > 6000) {
      throw new Error('Script must be between 1 and 6000 characters.');
    }
    if (BLOCKED_PYTHON_TOKENS.test(cleanCode)) {
      return {
        ok: false,
        runtime: 'python3 -I',
        approved,
        duration_ms: 0,
        stdout: '',
        error: 'Script blocked by static sandbox policy: filesystem, OS, process, network, or dynamic eval/import primitives are forbidden.',
        resource_limits: limits,
      };
    }

    // Wrap with Python AST import & attribute validator inside isolated Python mode
    const runnerWrapper = `
import ast, json, math, cmath, statistics, decimal, fractions, random

USER_CODE = ${JSON.stringify(cleanCode)}
ALLOWED_MODULES = {"math", "cmath", "statistics", "decimal", "fractions", "random", "json", "numpy", "scipy", "sympy"}
BLOCKED_NAMES = {"__import__", "open", "exec", "eval", "compile", "input", "breakpoint", "getattr", "setattr", "delattr", "globals", "locals", "vars", "dir"}

tree = ast.parse(USER_CODE, mode="exec")
for node in ast.walk(tree):
    if isinstance(node, ast.Import):
        for alias in node.names:
            root = alias.name.split(".")[0]
            if root not in ALLOWED_MODULES:
                raise PermissionError(f"Module '{root}' is not in the scientific sandbox allowlist.")
    elif isinstance(node, ast.ImportFrom):
        root = (node.module or "").split(".")[0]
        if root not in ALLOWED_MODULES:
            raise PermissionError(f"Module '{root}' is not in the scientific sandbox allowlist.")
    elif isinstance(node, ast.Name) and node.id in BLOCKED_NAMES:
        raise PermissionError(f"Identifier '{node.id}' is forbidden in the sandbox.")
    elif isinstance(node, ast.Attribute) and node.attr.startswith("__"):
        raise PermissionError("Access to dunder attributes is forbidden in the sandbox.")

exec(compile(tree, "<genesis_sandbox>", "exec"), {"__builtins__": {
    "abs": abs, "all": all, "any": any, "bool": bool, "complex": complex,
    "dict": dict, "enumerate": enumerate, "filter": filter, "float": float,
    "int": int, "len": len, "list": list, "map": map, "max": max, "min": min,
    "pow": pow, "print": print, "range": range, "round": round, "set": set,
    "sorted": sorted, "str": str, "sum": sum, "tuple": tuple, "zip": zip,
    "__import__": __import__, "Exception": Exception, "ValueError": ValueError
}})
`;

    const started = Date.now();
    try {
      const { stdout, stderr } = await execFileAsync(
        this.getPythonCommand(),
        ['-I', '-c', runnerWrapper],
        {
          timeout: boundedTimeout,
          maxBuffer: limits.max_stdout_bytes,
        }
      );
      const cleanStdout = (stdout || '').trim();
      const errText = (stderr || '').trim();

      let parsedJson: Record<string, unknown> | null = null;
      let chart: PlotChartSpec | undefined;

      const lines = cleanStdout.split(/\r?\n/).filter(Boolean);
      const lastLine = lines[lines.length - 1] || '';
      if (lastLine.startsWith('{') && lastLine.endsWith('}')) {
        try {
          const obj = JSON.parse(lastLine) as Record<string, unknown>;
          parsedJson = obj;
          if (Array.isArray(obj.points) && obj.points.length >= 2) {
            const validPts = obj.points
              .map((p: unknown) => p as { x?: unknown; y?: unknown })
              .filter((p) => Number.isFinite(Number(p.x)) && Number.isFinite(Number(p.y)))
              .map((p) => ({ x: Number(p.x), y: Number(p.y) }));
            if (validPts.length >= 2) {
              const xs = validPts.map((p) => p.x);
              const ys = validPts.map((p) => p.y);
              const yMin = Math.min(...ys);
              const yMax = Math.max(...ys);
              const yPad = Math.max(0.1, (yMax - yMin) * 0.08);
              chart = {
                title: String(obj.summary || 'Python Simulation Output'),
                x_label: String(obj.x_label || 'x'),
                y_label: String(obj.y_label || 'y'),
                x_min: Math.min(...xs),
                x_max: Math.max(...xs),
                y_min: yMin - yPad,
                y_max: yMax + yPad,
                series: [
                  {
                    id: 'py-sim',
                    label: String(obj.series_label || 'Simulation Curve'),
                    color: '#34d399',
                    points: validPts,
                  },
                ],
              };
            }
          }
        } catch {
          parsedJson = null;
        }
      }

      return {
        ok: true,
        runtime: 'python3 -I',
        approved,
        duration_ms: Date.now() - started,
        stdout: cleanStdout || errText || '(Completed with no stdout output)',
        parsed_json: parsedJson,
        chart,
        resource_limits: limits,
      };
    } catch (err) {
      const msg =
        typeof err === 'object' && err !== null && 'stderr' in err && (err as { stderr?: string }).stderr
          ? String((err as { stderr: string }).stderr).trim()
          : err instanceof Error
            ? err.message
            : 'Python execution failed or timed out.';
      return {
        ok: false,
        runtime: 'python3 -I',
        approved,
        duration_ms: Date.now() - started,
        stdout: '',
        error: msg.slice(0, 1200),
        resource_limits: limits,
      };
    }
  }
}
