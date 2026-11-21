import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import { getDb, hasFts5Support, runInTransaction, syncMemoryFtsIndexes } from '../db.ts';
import { resolveModelAdapter } from '../ai/adapters.ts';
import {
  chunkKnowledgeText,
  detectSensitiveSecret,
  formatRetrievedSystemContext,
  SqliteKeywordRetriever,
} from '../ai/memoryRetrieval.ts';
import { defaultAgentManager } from '../agent/agentManager.ts';
import { resolveCreatorFilePath, sanitizeCreatorFilename } from '../creator/fileSafety.ts';
import {
  exportDocumentAsDocx,
  exportDocumentAsMarkdown,
  exportDocumentAsPdf,
  exportDocumentAsText,
} from '../creator/documentStudio.ts';
import { runEngineeringCalculation } from './calculationEngine.ts';
import { generateEngineeringDiagram } from './designAssistant.ts';
import { ENGINEERING_DISCIPLINES, ENGINEERING_MATERIALS } from './disciplines.ts';
import type {
  CalculatorId,
  EngineeringDiagramKind,
  EngineeringDisciplineId,
  ExperimentalObservation,
  MathOperationType,
  ScientificExperimentRecord,
} from './interfaces.ts';
import { runMathComputation } from './mathEngine.ts';
import { LocalPythonSimulationAdapter, PYTHON_SIMULATION_PRESETS } from './simulationAdapter.ts';
import { convertUnitValue, SUPPORTED_UNIT_CATEGORIES } from './unitEngine.ts';

export interface EngineeringRuntimeSettings {
  operator_name: string;
  inference_endpoint_url: string;
  prefer_local_inference: boolean;
  active_model_id: string;
  inference_temperature: number;
  inference_max_tokens: number;
  inference_timeout_ms: number;
}

const VALID_CALCULATORS: CalculatorId[] = [
  'stress_strain',
  'force_torque_power',
  'motion_kinematics',
  'thermodynamics',
  'fluid_flow_pressure',
  'pump_compressor',
  'gear_shaft_design',
  'electrical_circuits',
];

const VALID_DIAGRAMS: EngineeringDiagramKind[] = [
  'beam_load',
  'shaft_step',
  'pressure_vessel',
  'rlc_circuit',
  'pipe_system',
];

const VALID_MATH_OPS: MathOperationType[] = [
  'evaluate',
  'derivative',
  'integral',
  'matrix_solve',
  'matrix_analyze',
  'ode_rk4',
  'root_find',
  'statistics_regression',
];

function parseJsonSafe<T>(raw: string | null | undefined, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function formatExperimentRow(row: Record<string, unknown>): ScientificExperimentRecord {
  return {
    id: String(row.id),
    title: String(row.title),
    discipline: (String(row.discipline || 'mechanical') as EngineeringDisciplineId),
    objective: String(row.objective || ''),
    established_facts: parseJsonSafe<string[]>(String(row.established_facts_json || '[]'), []),
    assumptions: parseJsonSafe<string[]>(String(row.assumptions_json || '[]'), []),
    hypothesis: String(row.hypothesis || ''),
    experimental_plan: String(row.experimental_plan || ''),
    observations: parseJsonSafe<ExperimentalObservation[]>(String(row.observations_json || '[]'), []),
    analysis_summary: String(row.analysis_summary || ''),
    sources: parseJsonSafe<ScientificExperimentRecord['sources']>(String(row.sources_json || '[]'), []),
    status: (String(row.status || 'planned') as ScientificExperimentRecord['status']),
    created_at: String(row.created_at),
    updated_at: String(row.updated_at),
  };
}

function analyzeExperimentObservations(observations: ExperimentalObservation[]) {
  if (!observations.length) {
    return {
      count: 0,
      mean_abs_error: 0,
      mean_pct_error: 0,
      max_pct_error: 0,
      rmse: 0,
      rows: [],
      summary: 'No experimental observations recorded yet. Add (theoretical, experimental) pairs to compare deviations.',
    };
  }

  let sumAbs = 0;
  let sumSq = 0;
  let sumPct = 0;
  let maxPct = 0;
  let pctCount = 0;

  const rows = observations.map((obs) => {
    const theo = Number(obs.theoretical_value);
    const exp = Number(obs.experimental_value);
    const diff = exp - theo;
    const absErr = Math.abs(diff);
    const pctErr = Math.abs(theo) > 1e-12 ? (absErr / Math.abs(theo)) * 100 : null;
    sumAbs += absErr;
    sumSq += diff * diff;
    if (pctErr !== null) {
      sumPct += pctErr;
      maxPct = Math.max(maxPct, pctErr);
      pctCount += 1;
    }
    return {
      ...obs,
      residual: Number(diff.toPrecision(6)),
      abs_error: Number(absErr.toPrecision(6)),
      pct_error: pctErr !== null ? Number(pctErr.toFixed(3)) : null,
    };
  });

  const n = observations.length;
  const mae = sumAbs / n;
  const rmse = Math.sqrt(sumSq / n);
  const meanPct = pctCount > 0 ? sumPct / pctCount : 0;

  return {
    count: n,
    mean_abs_error: Number(mae.toPrecision(6)),
    mean_pct_error: Number(meanPct.toFixed(3)),
    max_pct_error: Number(maxPct.toFixed(3)),
    rmse: Number(rmse.toPrecision(6)),
    rows,
    summary: `Compared ${n} experimental point(s) against theory: mean error = ${meanPct.toFixed(2)}% (max ${maxPct.toFixed(2)}%), RMSE = ${Number(rmse.toPrecision(5))}.`,
  };
}

export function createEngineeringRouter(getSettings: () => EngineeringRuntimeSettings): express.Router {
  const router = express.Router();
  const simAdapter = new LocalPythonSimulationAdapter();

  router.get('/status', async (_req, res) => {
    const simulationTools = await simAdapter.probeCapabilities();
    res.json({
      operational: true,
      calculators: VALID_CALCULATORS,
      math_operations: VALID_MATH_OPS,
      diagram_kinds: VALID_DIAGRAMS,
      disciplines_count: ENGINEERING_DISCIPLINES.length,
      materials_count: ENGINEERING_MATERIALS.length,
      unit_categories: SUPPORTED_UNIT_CATEGORIES,
      simulation_tools: simulationTools,
      safety_notice:
        'Step 11 calculations validate physical units and numerical consistency locally without fabricating results. Not a substitute for certified PE sign-off.',
    });
  });

  router.get('/disciplines', (_req, res) => {
    res.json({
      disciplines: ENGINEERING_DISCIPLINES,
      materials: ENGINEERING_MATERIALS,
    });
  });

  router.get('/materials', (_req, res) => {
    res.json(ENGINEERING_MATERIALS);
  });

  router.post('/disciplines/explain', async (req, res) => {
    const db = getDb();
    const { discipline_id, question, model_id } = req.body as {
      discipline_id?: EngineeringDisciplineId;
      question?: string;
      model_id?: string | null;
    };

    const ref =
      ENGINEERING_DISCIPLINES.find((d) => d.id === discipline_id) || ENGINEERING_DISCIPLINES[0];
    const cleanQ = (question || '').trim();
    if (!cleanQ) {
      res.json({
        mode: 'reference',
        discipline: ref,
        explanation: `${ref.name}: ${ref.overview}`,
      });
      return;
    }

    const retrieval = new SqliteKeywordRetriever(db).retrieve(`${ref.name} ${cleanQ}`, {
      includeMemory: true,
      includeKnowledge: true,
      maxMemoryItems: 3,
      maxKnowledgeChunks: 3,
    });
    const sysContext = formatRetrievedSystemContext(retrieval);

    const settings = getSettings();
    const targetModelId = model_id || settings.active_model_id || 'genesis-core-placeholder';
    const resolved = resolveModelAdapter(db, targetModelId, settings.inference_endpoint_url);

    if (
      'error' in resolved ||
      resolved.adapter.provider === 'genesis_core' ||
      resolved.model.id === 'genesis-core-placeholder'
    ) {
      const formulaBlock = ref.key_formulas.map((f) => `- **${f.name}**: \`${f.equation}\` (${f.variables})`).join('\n');
      res.json({
        mode: 'deterministic_reference',
        discipline: ref,
        context_used: {
          memories: retrieval.memories.length,
          knowledge: retrieval.knowledge.length,
        },
        explanation: [
          `### ${ref.name} — Reference Response`,
          `**Query**: ${cleanQ}`,
          '',
          ref.overview,
          '',
          '**Established Formulas:**',
          formulaBlock,
          '',
          '**Key Assumptions:**',
          ...ref.assumptions.map((a) => `- ${a}`),
          '',
          '*Connect a loopback local LLM in Model Manager / System Settings for free-form problem derivation while preserving exact formula calculations in the Calculator tab.*',
        ].join('\n'),
      });
      return;
    }

    try {
      const completion = await resolved.adapter.generate({
        messages: [
          {
            role: 'system',
            content: [
              `You are assisting within Project Genesis Engineering & Scientific Intelligence (${ref.name}).`,
              'Distinguish established physical laws from engineering assumptions. Never fabricate numerical test data.',
              ...(sysContext ? [sysContext] : []),
            ].join('\n\n'),
          },
          {
            role: 'user',
            content: `Topic: ${ref.name}\nCore formulas: ${ref.key_formulas.map((f) => `${f.name} (${f.equation})`).join('; ')}\nQuestion: ${cleanQ}`,
          },
        ],
        temperature: 0.2,
        max_tokens: settings.inference_max_tokens,
        timeout_ms: settings.inference_timeout_ms,
        model: resolved.model.name,
      });
      if (!completion.ok) {
        res.status(502).json({
          error: completion.error || 'Local model engineering explanation failed.',
        });
        return;
      }
      res.json({
        mode: 'local_inference',
        model_name: completion.model_name,
        discipline: ref,
        context_used: {
          memories: retrieval.memories.length,
          knowledge: retrieval.knowledge.length,
        },
        explanation: completion.content,
      });
    } catch (err) {
      res.status(502).json({
        error: err instanceof Error ? err.message : 'Local model engineering explanation failed.',
      });
    }
  });

  router.post('/convert-units', (req, res) => {
    const { value, from_unit, to_unit } = req.body as {
      value?: number;
      from_unit?: string;
      to_unit?: string;
    };
    try {
      const result = convertUnitValue(Number(value), String(from_unit || ''), String(to_unit || ''));
      res.json(result);
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : 'Unit conversion error.' });
    }
  });

  router.get('/calculations', (_req, res) => {
    const db = getDb();
    const rows = db
      .prepare('SELECT * FROM engineering_calculations ORDER BY created_at DESC LIMIT 30')
      .all() as Array<Record<string, unknown>>;
    res.json(
      rows.map((r) => ({
        id: r.id,
        calculator_type: r.calculator_type,
        title: r.title,
        inputs: parseJsonSafe(String(r.inputs_json), {}),
        results: parseJsonSafe(String(r.results_json), {}),
        warnings: parseJsonSafe(String(r.warnings_json), []),
        created_at: r.created_at,
      }))
    );
  });

  router.post('/calculate', (req, res) => {
    const { calculator, inputs, save_history } = req.body as {
      calculator?: CalculatorId;
      inputs?: Record<string, { value: number; unit?: string } | number>;
      save_history?: boolean;
    };

    if (!calculator || !VALID_CALCULATORS.includes(calculator)) {
      res.status(400).json({ error: `Invalid calculator "${calculator}". Valid: ${VALID_CALCULATORS.join(', ')}` });
      return;
    }

    try {
      const result = runEngineeringCalculation(calculator, inputs || {});
      if (save_history !== false) {
        const db = getDb();
        db.prepare(
          'INSERT INTO engineering_calculations (id, calculator_type, title, inputs_json, results_json, warnings_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
        ).run(
          `ecalc-${crypto.randomUUID()}`,
          calculator,
          result.title,
          JSON.stringify(inputs || {}),
          JSON.stringify(result.outputs),
          JSON.stringify(result.warnings),
          new Date().toISOString()
        );
      }
      res.json(result);
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : 'Engineering calculation failed.' });
    }
  });

  router.post('/math', (req, res) => {
    const { operation, params } = req.body as {
      operation?: MathOperationType;
      params?: Record<string, unknown>;
    };

    if (!operation || !VALID_MATH_OPS.includes(operation)) {
      res.status(400).json({ error: `Invalid math operation "${operation}".` });
      return;
    }

    try {
      const output = runMathComputation(operation, params || {});
      res.json(output);
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : 'Mathematical computation failed.' });
    }
  });

  router.post('/design/diagram', (req, res) => {
    const { kind, params, drawing_notes } = req.body as {
      kind?: EngineeringDiagramKind;
      params?: Record<string, unknown>;
      drawing_notes?: string;
    };

    if (!kind || !VALID_DIAGRAMS.includes(kind)) {
      res.status(400).json({ error: `Invalid diagram kind "${kind}". Valid: ${VALID_DIAGRAMS.join(', ')}` });
      return;
    }

    try {
      const result = generateEngineeringDiagram(kind, params || {}, drawing_notes);
      res.json(result);
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : 'Diagram generation failed.' });
    }
  });

  router.get('/simulate/presets', async (_req, res) => {
    const capabilities = await simAdapter.probeCapabilities();
    res.json({ capabilities, presets: PYTHON_SIMULATION_PRESETS });
  });

  router.post('/simulate', async (req, res) => {
    const { code, approved, timeout_ms } = req.body as {
      code?: string;
      approved?: boolean;
      timeout_ms?: number;
    };

    try {
      const result = await simAdapter.runRestrictedScript(
        String(code || ''),
        Boolean(approved),
        typeof timeout_ms === 'number' ? timeout_ms : 4000
      );
      if (!result.ok) {
        res.status(400).json(result);
        return;
      }
      res.json(result);
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : 'Simulation execution denied.' });
    }
  });

  // ---------------------------------------------------------------------------
  // Scientific Research Workspace CRUD & Analysis
  // ---------------------------------------------------------------------------
  router.get('/experiments', (_req, res) => {
    const db = getDb();
    const rows = db
      .prepare('SELECT * FROM scientific_experiments ORDER BY updated_at DESC')
      .all() as Array<Record<string, unknown>>;
    res.json(
      rows.map((r) => {
        const exp = formatExperimentRow(r);
        return {
          ...exp,
          comparison: analyzeExperimentObservations(exp.observations),
        };
      })
    );
  });

  router.post('/experiments', (req, res) => {
    const db = getDb();
    const body = req.body as Partial<ScientificExperimentRecord>;
    if (!body.title || !String(body.title).trim()) {
      res.status(400).json({ error: 'Experiment title is required.' });
      return;
    }

    const id = `exp-${crypto.randomUUID()}`;
    const now = new Date().toISOString();
    const observations = Array.isArray(body.observations) ? body.observations : [];
    const comparison = analyzeExperimentObservations(observations);

    db.prepare(
      `INSERT INTO scientific_experiments
       (id, title, discipline, objective, established_facts_json, assumptions_json, hypothesis, experimental_plan, observations_json, analysis_summary, sources_json, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      id,
      String(body.title).trim().slice(0, 160),
      String(body.discipline || 'mechanical'),
      String(body.objective || '').trim(),
      JSON.stringify(Array.isArray(body.established_facts) ? body.established_facts : []),
      JSON.stringify(Array.isArray(body.assumptions) ? body.assumptions : []),
      String(body.hypothesis || '').trim(),
      String(body.experimental_plan || '').trim(),
      JSON.stringify(observations),
      String(body.analysis_summary || comparison.summary).trim(),
      JSON.stringify(Array.isArray(body.sources) ? body.sources : []),
      observations.length > 0 ? 'analyzed' : 'planned',
      now,
      now
    );

    const row = db.prepare('SELECT * FROM scientific_experiments WHERE id = ?').get(id) as Record<string, unknown>;
    const formatted = formatExperimentRow(row);
    res.status(201).json({ ...formatted, comparison });
  });

  router.put('/experiments/:id', (req, res) => {
    const db = getDb();
    const existing = db.prepare('SELECT * FROM scientific_experiments WHERE id = ?').get(req.params.id) as
      | Record<string, unknown>
      | undefined;
    if (!existing) {
      res.status(404).json({ error: 'Experiment record not found.' });
      return;
    }

    const current = formatExperimentRow(existing);
    const body = req.body as Partial<ScientificExperimentRecord>;
    const nextObs = Array.isArray(body.observations) ? body.observations : current.observations;
    const comparison = analyzeExperimentObservations(nextObs);
    const now = new Date().toISOString();

    db.prepare(
      `UPDATE scientific_experiments
       SET title = ?, discipline = ?, objective = ?, established_facts_json = ?, assumptions_json = ?, hypothesis = ?, experimental_plan = ?, observations_json = ?, analysis_summary = ?, sources_json = ?, status = ?, updated_at = ?
       WHERE id = ?`
    ).run(
      typeof body.title === 'string' && body.title.trim() ? body.title.trim().slice(0, 160) : current.title,
      body.discipline || current.discipline,
      typeof body.objective === 'string' ? body.objective : current.objective,
      JSON.stringify(Array.isArray(body.established_facts) ? body.established_facts : current.established_facts),
      JSON.stringify(Array.isArray(body.assumptions) ? body.assumptions : current.assumptions),
      typeof body.hypothesis === 'string' ? body.hypothesis : current.hypothesis,
      typeof body.experimental_plan === 'string' ? body.experimental_plan : current.experimental_plan,
      JSON.stringify(nextObs),
      typeof body.analysis_summary === 'string' ? body.analysis_summary : comparison.summary,
      JSON.stringify(Array.isArray(body.sources) ? body.sources : current.sources),
      body.status || (nextObs.length > 0 ? 'analyzed' : current.status),
      now,
      req.params.id
    );

    const updated = db.prepare('SELECT * FROM scientific_experiments WHERE id = ?').get(req.params.id) as Record<string, unknown>;
    const formatted = formatExperimentRow(updated);
    res.json({ ...formatted, comparison });
  });

  router.delete('/experiments/:id', (req, res) => {
    const db = getDb();
    const result = db.prepare('DELETE FROM scientific_experiments WHERE id = ?').run(req.params.id);
    if (result.changes === 0) {
      res.status(404).json({ error: 'Experiment record not found.' });
      return;
    }
    res.json({ deleted: true, id: req.params.id });
  });

  // ---------------------------------------------------------------------------
  // Technical Report & Diagram Export (.pdf, .docx, .md, .txt, .svg)
  // ---------------------------------------------------------------------------
  router.post('/export-report', async (req, res) => {
    const settings = getSettings();
    const { title, format, markdown_content, svg_content } = req.body as {
      title?: string;
      format?: 'pdf' | 'docx' | 'md' | 'txt' | 'svg';
      markdown_content?: string;
      svg_content?: string;
    };

    const cleanTitle = (title || 'Genesis Engineering Technical Report').trim().slice(0, 120);
    const fmt = format || 'md';
    const stem = cleanTitle.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'engineering_report';

    try {
      if (fmt === 'svg') {
        const cleanSvg = String(svg_content || '').trim();
        if (!cleanSvg.startsWith('<svg') || /<script/i.test(cleanSvg)) {
          res.status(400).json({ error: 'Valid script-free SVG payload is required for SVG export.' });
          return;
        }
        res.setHeader('Content-Type', 'image/svg+xml; charset=utf-8');
        res.setHeader('Content-Disposition', `attachment; filename="${stem}.svg"`);
        res.send(cleanSvg);
        return;
      }

      const bodyText = String(markdown_content || '').trim();
      if (!bodyText) {
        res.status(400).json({ error: 'Report markdown_content is required.' });
        return;
      }

      if (fmt === 'docx') {
        const buf = await exportDocumentAsDocx(cleanTitle, bodyText, settings.operator_name);
        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
        res.setHeader('Content-Disposition', `attachment; filename="${stem}.docx"`);
        res.send(buf);
        return;
      }
      if (fmt === 'pdf') {
        const buf = await exportDocumentAsPdf(cleanTitle, bodyText, settings.operator_name);
        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', `attachment; filename="${stem}.pdf"`);
        res.send(buf);
        return;
      }
      if (fmt === 'txt') {
        const buf = exportDocumentAsText(cleanTitle, bodyText);
        res.setHeader('Content-Type', 'text/plain; charset=utf-8');
        res.setHeader('Content-Disposition', `attachment; filename="${stem}.txt"`);
        res.send(buf);
        return;
      }

      const buf = exportDocumentAsMarkdown(cleanTitle, bodyText);
      res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="${stem}.md"`);
      res.send(buf);
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : 'Report export failed.' });
    }
  });

  // ---------------------------------------------------------------------------
  // Cross-Module Integrations (Memory, KB, Research, Lab, Creator, Agent OS)
  // ---------------------------------------------------------------------------
  router.post('/integrate/memory', (req, res) => {
    const db = getDb();
    const { title, content, tags, approved } = req.body as {
      title?: string;
      content?: string;
      tags?: string[];
      approved?: boolean;
    };

    if (!approved) {
      res.status(400).json({ error: 'Explicit approval (approved: true) is required to save engineering results to Memory.' });
      return;
    }
    if (!title?.trim() || !content?.trim()) {
      res.status(400).json({ error: 'Memory title and content are required.' });
      return;
    }
    const secretHit = detectSensitiveSecret(`${title}\n${content}`);
    if (secretHit) {
      res.status(400).json({ error: `Refused memory save: detected potential ${secretHit}.` });
      return;
    }

    const id = `mem-${crypto.randomUUID()}`;
    const now = new Date().toISOString();
    db.prepare(
      'INSERT INTO memory_entries (id, namespace, category, title, content, tags_json, importance, approved, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?)'
    ).run(
      id,
      'project',
      'fact',
      title.trim().slice(0, 140),
      content.trim(),
      JSON.stringify(Array.isArray(tags) && tags.length ? tags : ['engineering', 'step-11']),
      4,
      now,
      now
    );
    syncMemoryFtsIndexes(db);
    res.status(201).json(db.prepare('SELECT * FROM memory_entries WHERE id = ?').get(id));
  });

  router.post('/integrate/knowledge', (req, res) => {
    const db = getDb();
    const { title, source_name, content, tags } = req.body as {
      title?: string;
      source_name?: string;
      content?: string;
      tags?: string[];
    };
    if (!title?.trim() || !content?.trim()) {
      res.status(400).json({ error: 'Knowledge document title and content are required.' });
      return;
    }

    const id = `kdoc-${crypto.randomUUID()}`;
    const now = new Date().toISOString();
    const chunks = chunkKnowledgeText(content.trim());

    runInTransaction(db, () => {
      db.prepare(
        `INSERT INTO knowledge_documents (id, title, source_type, source_name, content, tags_json, char_count, chunk_count, created_at, updated_at)
         VALUES (?, ?, 'engineering_report', ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        id,
        title.trim().slice(0, 140),
        (source_name || 'engineering_workbench.md').trim(),
        content.trim(),
        JSON.stringify(Array.isArray(tags) && tags.length ? tags : ['engineering', 'scientific']),
        content.trim().length,
        chunks.length,
        now,
        now
      );

      const insChunk = db.prepare(
        'INSERT INTO knowledge_chunks (id, document_id, chunk_index, content, token_estimate, created_at) VALUES (?, ?, ?, ?, ?, ?)'
      );
      chunks.forEach((chunk, idx) => {
        insChunk.run(`kchk-${crypto.randomUUID()}`, id, idx, chunk.content, chunk.token_estimate, now);
      });
    });

    if (hasFts5Support(db)) {
      syncMemoryFtsIndexes(db);
    }
    res.status(201).json(db.prepare('SELECT * FROM knowledge_documents WHERE id = ?').get(id));
  });

  router.post('/integrate/research', (req, res) => {
    const db = getDb();
    const { title, summary, notes, tags } = req.body as {
      title?: string;
      summary?: string;
      notes?: string;
      tags?: string[];
    };
    if (!title?.trim() || !notes?.trim()) {
      res.status(400).json({ error: 'Research title and notes are required.' });
      return;
    }
    const id = `res-${crypto.randomUUID()}`;
    const now = new Date().toISOString();
    db.prepare(
      'INSERT INTO research_projects (id, title, summary, status, tags_json, sources_json, notes, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
    ).run(
      id,
      title.trim().slice(0, 140),
      (summary || 'Sent from Genesis Engineering & Scientific Intelligence').trim(),
      'active',
      JSON.stringify(Array.isArray(tags) && tags.length ? tags : ['engineering', 'step-11']),
      JSON.stringify([{ id: `src-${crypto.randomUUID().slice(0, 8)}`, title: title.trim(), reference: 'engineering://step-11', note: 'Verified computation report' }]),
      notes.trim(),
      now,
      now
    );
    res.status(201).json(db.prepare('SELECT * FROM research_projects WHERE id = ?').get(id));
  });

  router.post('/integrate/laboratory', (req, res) => {
    const db = getDb();
    const { name, content, metrics } = req.body as {
      name?: string;
      content?: string;
      metrics?: Record<string, unknown>;
    };
    if (!name?.trim() || !content?.trim()) {
      res.status(400).json({ error: 'Laboratory item name and content are required.' });
      return;
    }
    const id = `lab-${crypto.randomUUID()}`;
    const now = new Date().toISOString();
    db.prepare(
      'INSERT INTO laboratory_items (id, kind, name, content, schema_json, metrics_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
    ).run(
      id,
      'evaluation_benchmark',
      name.trim().slice(0, 140),
      content.trim(),
      JSON.stringify({ domain: 'engineering_scientific', step: 11 }),
      JSON.stringify(metrics || {}),
      now,
      now
    );
    res.status(201).json(db.prepare('SELECT * FROM laboratory_items WHERE id = ?').get(id));
  });

  router.post('/integrate/creator', (req, res) => {
    const db = getDb();
    const { project_id, filename, content, overwrite, summary } = req.body as {
      project_id?: string;
      filename?: string;
      content?: string;
      overwrite?: boolean;
      summary?: string;
    };
    const targetProjectId = project_id || 'proj-genesis-studio';
    const project = db.prepare('SELECT id, name FROM creator_projects WHERE id = ?').get(targetProjectId) as
      | { id: string; name: string }
      | undefined;
    if (!project) {
      res.status(404).json({ error: `Creator project "${targetProjectId}" not found.` });
      return;
    }
    if (!content?.trim()) {
      res.status(400).json({ error: 'Content is required.' });
      return;
    }

    try {
      const safeBase = sanitizeCreatorFilename(filename || `engineering_report_${Date.now()}.md`);
      const ext = path.extname(safeBase).toLowerCase();
      const finalName = ext === '.md' || ext === '.txt' ? safeBase : `${path.parse(safeBase).name}.md`;
      const format = finalName.endsWith('.txt') ? 'txt' : 'markdown';
      const now = new Date().toISOString();

      const existing = db
        .prepare('SELECT id, version FROM creator_project_files WHERE project_id = ? AND filename = ?')
        .get(targetProjectId, finalName) as { id: string; version: number } | undefined;

      if (existing && !overwrite) {
        res.status(409).json({
          error: `File "${finalName}" already exists in "${project.name}". Confirm overwrite to save a new revision.`,
          code: 'OVERWRITE_CONFIRMATION_REQUIRED',
          existing_name: finalName,
        });
        return;
      }

      const diskPath = resolveCreatorFilePath(targetProjectId, finalName);
      fs.writeFileSync(diskPath, content, 'utf-8');

      const fileId = existing?.id || `cfile-${crypto.randomUUID()}`;
      const version = existing ? existing.version + 1 : 1;

      runInTransaction(db, () => {
        if (existing) {
          db.prepare('UPDATE creator_project_files SET content = ?, version = ?, updated_at = ? WHERE id = ?').run(
            content,
            version,
            now,
            existing.id
          );
        } else {
          db.prepare(
            `INSERT INTO creator_project_files (id, project_id, filename, kind, format, content, metadata_json, version, created_at, updated_at)
             VALUES (?, ?, ?, 'document', ?, ?, ?, 1, ?, ?)`
          ).run(fileId, targetProjectId, finalName, format, content, JSON.stringify({ source: 'engineering_step11' }), now, now);
        }
        db.prepare(
          'INSERT INTO creator_revisions (id, file_id, project_id, version, summary, content, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
        ).run(
          `crev-${crypto.randomUUID()}`,
          fileId,
          targetProjectId,
          version,
          summary || 'Saved from Engineering & Scientific Intelligence',
          content,
          now
        );
        db.prepare('UPDATE creator_projects SET updated_at = ? WHERE id = ?').run(now, targetProjectId);
      });

      const saved = db.prepare('SELECT * FROM creator_project_files WHERE id = ?').get(fileId);
      res.status(existing ? 200 : 201).json({ file: saved, project_name: project.name });
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : 'Failed to save report to Creator Studio.' });
    }
  });

  router.post('/integrate/agent', async (req, res) => {
    const db = getDb();
    const { goal, agent_id, report_summary } = req.body as {
      goal?: string;
      agent_id?: string;
      report_summary?: string;
    };

    let targetAgentId = agent_id || 'agent-task-operator';
    let agentExists = db.prepare('SELECT id FROM agents WHERE id = ?').get(targetAgentId) as { id: string } | undefined;
    if (!agentExists && !agent_id) {
      agentExists = db.prepare('SELECT id FROM agents ORDER BY id ASC LIMIT 1').get() as { id: string } | undefined;
      if (agentExists) targetAgentId = agentExists.id;
    }
    if (!agentExists) {
      res.status(404).json({ error: `Agent "${targetAgentId}" not found.` });
      return;
    }

    const fullGoal = [
      (goal || 'Verify engineering calculations and compile scientific review memo').trim(),
      report_summary ? `\nContext:\n${report_summary.slice(0, 1500)}` : '',
    ].join('');

    const created = await defaultAgentManager.createAndPlanTask(db, {
      agentId: targetAgentId,
      goal: fullGoal,
      title: 'Engineering Task',
    });
    res.status(201).json(created);
  });

  return router;
}
