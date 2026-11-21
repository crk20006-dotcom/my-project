import type { EngineeringDiagramKind, EngineeringDiagramResult } from './interfaces.ts';

function escSvg(text: string): string {
  return String(text || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function interpretDrawingNotes(notes: string): {
  detected_standards: string[];
  detected_tolerances: string[];
  detected_dimensions: string[];
  summary: string;
} {
  const clean = (notes || '').trim();
  const standards: string[] = [];
  if (/ASME\s*Y14\.5/i.test(clean)) standards.push('ASME Y14.5 (GD&T Third-Angle Projection)');
  if (/ISO\s*1101|ISO\s*2768/i.test(clean)) standards.push('ISO 1101 / ISO 2768 (Geometrical & General Tolerancing)');
  if (/ISO\s*286|[Hh]\d\/[fgkmnps]\d/.test(clean)) standards.push('ISO 286 Limits & Fits');

  const tolerances = Array.from(
    new Set(
      (clean.match(/(±\s*\d+(?:\.\d+)?\s*(?:mm|in|μm)?|[A-Za-z]\d\/[a-z]\d|⌖\s*[\d.]+|⏥\s*[\d.]+|⊥\s*[\d.]+)/g) || [])
        .slice(0, 12)
    )
  );
  const dimensions = Array.from(
    new Set(
      (clean.match(/(?:Ø|R|M)?\d+(?:\.\d+)?\s*(?:mm|cm|m|in|deg|°|MPa|kN|N·m)/g) || []).slice(0, 16)
    )
  );

  const summary = clean
    ? `Detected ${standards.length} standard reference(s), ${dimensions.length} explicit dimensional callout(s), and ${tolerances.length} tolerance callout(s). Ensure primary Datum A-B-C precedence matches functional mating surfaces.`
    : 'Paste drawing OCR text, title-block notes, or tolerance callouts to extract engineering standards and datum/fit guidance.';

  return {
    detected_standards: standards,
    detected_tolerances: tolerances,
    detected_dimensions: dimensions,
    summary,
  };
}

export function generateEngineeringDiagram(
  kind: EngineeringDiagramKind,
  params: Record<string, unknown>,
  drawingNotes?: string
): EngineeringDiagramResult {
  const num = (k: string, fallback: number) => {
    const v = Number(params[k]);
    return Number.isFinite(v) && v > 0 ? v : fallback;
  };
  const str = (k: string, fallback: string) => {
    const v = params[k];
    return typeof v === 'string' && v.trim() ? escSvg(v.trim().slice(0, 48)) : fallback;
  };

  let title = '';
  let svg = '';
  let dimensions: EngineeringDiagramResult['dimensions'] = [];
  let cadGuidance: string[] = [];
  let drawingNotesOut: string[] = [];

  if (kind === 'beam_load') {
    const span = num('span_m', 4);
    const load = num('load_kn', 12);
    const heightMm = num('depth_mm', 160);
    const reaction = (load / 2).toFixed(2);
    const mMax = ((load * span) / 4).toFixed(2);

    title = `Simply Supported Beam Schematic (L = ${span} m, P = ${load} kN)`;
    dimensions = [
      { callout: 'Span Length (L)', value: `${span} m`, tolerance: '±5 mm erection' },
      { callout: 'Point Load (P)', value: `${load} kN at L/2` },
      { callout: 'Reactions (R_A, R_B)', value: `${reaction} kN each` },
      { callout: 'Peak Moment (M_max)', value: `${mMax} kN·m`, tolerance: `Depth ${heightMm} mm` },
    ];
    cadGuidance = [
      'Anchor structural profile sketch at neutral-axis centroid so section modulus updates symmetrically.',
      'Model bearing stiffener plates at R_A, R_B, and mid-span load pad to prevent local web crippling.',
    ];
    drawingNotesOut = [
      'Show centerline of pin (A) and roller (B) supports relative to Gridline Datum.',
      'Verify flange lateral bracing spacing before fabricating long spans.',
    ];

    svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 640 280" width="640" height="280">
  <rect width="640" height="280" fill="#0B1018"/>
  <g stroke="#1E293B" stroke-width="1">
    <line x1="40" y1="40" x2="600" y2="40"/><line x1="40" y1="240" x2="600" y2="240"/>
  </g>
  <line x1="320" y1="36" x2="320" y2="112" stroke="#F59E0B" stroke-width="3"/>
  <polygon points="320,122 312,106 328,106" fill="#F59E0B"/>
  <text x="334" y="64" fill="#FCD34D" font-family="monospace" font-size="13">P = ${load} kN</text>
  <rect x="90" y="124" width="460" height="24" fill="#1D4ED8" fill-opacity="0.35" stroke="#60A5FA" stroke-width="2"/>
  <text x="242" y="140" fill="#E2E8F0" font-family="monospace" font-size="12">Section h=${heightMm} mm | M_max=${mMax} kN·m</text>
  <polygon points="90,148 74,178 106,178" fill="none" stroke="#34D399" stroke-width="2"/>
  <circle cx="550" cy="162" r="14" fill="none" stroke="#34D399" stroke-width="2"/>
  <line x1="530" y1="178" x2="570" y2="178" stroke="#34D399" stroke-width="2"/>
  <text x="64" y="198" fill="#6EE7B7" font-family="monospace" font-size="12">R_A = ${reaction} kN</text>
  <text x="498" y="198" fill="#6EE7B7" font-family="monospace" font-size="12">R_B = ${reaction} kN</text>
  <line x1="90" y1="224" x2="550" y2="224" stroke="#94A3B8" stroke-width="1.5"/>
  <line x1="90" y1="214" x2="90" y2="232" stroke="#94A3B8" stroke-width="1.5"/>
  <line x1="550" y1="214" x2="550" y2="232" stroke="#94A3B8" stroke-width="1.5"/>
  <text x="275" y="218" fill="#CBD5E1" font-family="monospace" font-size="13">Span L = ${span} m</text>
</svg>`;
  } else if (kind === 'shaft_step') {
    const d1 = num('d_journal_mm', 25);
    const d2 = num('d_shoulder_mm', 36);
    const totalL = num('length_mm', 180);
    const fillet = num('fillet_mm', 2);

    title = `Stepped Transmission Shaft (Ø${d1} / Ø${d2} mm × ${totalL} mm)`;
    dimensions = [
      { callout: 'Bearing Journal (D1)', value: `Ø${d1} mm`, tolerance: 'ISO k6 / g6 ground' },
      { callout: 'Shoulder Diameter (D2)', value: `Ø${d2} mm`, tolerance: '±0.10 mm' },
      { callout: 'Shoulder Fillet Radius (R)', value: `R${fillet} mm`, tolerance: 'Kt fatigue relief' },
      { callout: 'Overall Length (L)', value: `${totalL} mm`, tolerance: 'ISO 2768-m' },
    ];
    cadGuidance = [
      'Revolve half-profile strictly around centerline Datum Axis A so concentricity holds automatically.',
      'Enforce shoulder fillet R >= 0.06 * D1 or undercut relief before bearing seats so inner race seats flush.',
    ];
    drawingNotesOut = [
      'Specify Datum A as centerline axis across both bearing journals.',
      'Add circular runout <= 0.015 mm relative to Datum A-B and Ra 0.8 μm finish on bearing journals.',
    ];

    svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 640 280" width="640" height="280">
  <rect width="640" height="280" fill="#0B1018"/>
  <line x1="50" y1="140" x2="590" y2="140" stroke="#F59E0B" stroke-width="1.2" stroke-dasharray="8 4 2 4"/>
  <rect x="90" y="106" width="110" height="68" fill="#1E293B" stroke="#60A5FA" stroke-width="2"/>
  <rect x="200" y="84" width="240" height="112" fill="#1D4ED8" fill-opacity="0.3" stroke="#60A5FA" stroke-width="2"/>
  <rect x="440" y="106" width="110" height="68" fill="#1E293B" stroke="#60A5FA" stroke-width="2"/>
  <text x="275" y="135" fill="#E2E8F0" font-family="monospace" font-size="12">DATUM AXIS A</text>
  <text x="108" y="96" fill="#93C5FD" font-family="monospace" font-size="12">Ø${d1} k6</text>
  <text x="292" y="74" fill="#93C5FD" font-family="monospace" font-size="12">Ø${d2} ±0.10</text>
  <text x="458" y="96" fill="#93C5FD" font-family="monospace" font-size="12">Ø${d1} k6</text>
  <text x="182" y="214" fill="#FCD34D" font-family="monospace" font-size="11">R${fillet} fillet (shoulder relief)</text>
  <line x1="90" y1="242" x2="550" y2="242" stroke="#94A3B8" stroke-width="1.5"/>
  <line x1="90" y1="232" x2="90" y2="250" stroke="#94A3B8" stroke-width="1.5"/>
  <line x1="550" y1="232" x2="550" y2="250" stroke="#94A3B8" stroke-width="1.5"/>
  <text x="260" y="236" fill="#CBD5E1" font-family="monospace" font-size="13">Total Length = ${totalL} mm</text>
</svg>`;
  } else if (kind === 'pressure_vessel') {
    const idMm = num('inner_diameter_mm', 600);
    const wallMm = num('wall_mm', 8);
    const pBar = num('pressure_bar', 16);
    const hoopMpa = (((pBar * 0.1) * (idMm / 2)) / wallMm).toFixed(2);
    const longMpa = (Number(hoopMpa) / 2).toFixed(2);

    title = `Thin-Wall Cylindrical Pressure Vessel Cross-Section (ID ${idMm} mm, t = ${wallMm} mm)`;
    dimensions = [
      { callout: 'Inner Diameter (ID)', value: `${idMm} mm`, tolerance: 'r/t = ' + (idMm / (2 * wallMm)).toFixed(1) },
      { callout: 'Shell Thickness (t)', value: `${wallMm} mm`, tolerance: 'Corrosion allowance +1.5 mm' },
      { callout: 'Operating Pressure (P)', value: `${pBar} bar (${(pBar * 0.1).toFixed(2)} MPa)` },
      { callout: 'Hoop / Longitudinal Stress', value: `σ_h = ${hoopMpa} MPa / σ_L = ${longMpa} MPa` },
    ];
    cadGuidance = [
      'Use full 360° revolve with tangential elliptical (2:1) or hemispherical end heads to avoid sharp knuckle stress.',
      'Model reinforcing pads around radial nozzle cutouts per ASME BPVC Section VIII Div. 1.',
    ];
    drawingNotesOut = [
      `Thin-wall assumption (r/t >= 10) gives r/t = ${(idMm / (2 * wallMm)).toFixed(1)}.`,
      'Hydrostatic proof test pressure, RT/UT weld NDE %, and relief valve setpoint must appear in Vessel Datasheet.',
    ];

    svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 640 280" width="640" height="280">
  <rect width="640" height="280" fill="#0B1018"/>
  <path d="M 150 70 H 490 A 55 70 0 0 1 490 210 H 150 A 55 70 0 0 1 150 70 Z" fill="#1D4ED8" fill-opacity="0.18" stroke="#60A5FA" stroke-width="5"/>
  <path d="M 155 82 H 485 A 45 58 0 0 1 485 198 H 155 A 45 58 0 0 1 155 82 Z" fill="none" stroke="#93C5FD" stroke-width="1.5" stroke-dasharray="4 4"/>
  <text x="230" y="132" fill="#E2E8F0" font-family="monospace" font-size="13">P = ${pBar} bar | ID = ${idMm} mm</text>
  <text x="218" y="156" fill="#FCD34D" font-family="monospace" font-size="12">σ_hoop = ${hoopMpa} MPa | t = ${wallMm} mm</text>
  <line x1="150" y1="238" x2="490" y2="238" stroke="#94A3B8" stroke-width="1.5"/>
  <text x="242" y="256" fill="#CBD5E1" font-family="monospace" font-size="12">Cylindrical Shell + Ellipsoidal Heads</text>
</svg>`;
  } else if (kind === 'rlc_circuit') {
    const vStr = str('voltage_v', '120V AC');
    const rVal = num('resistance_ohm', 24);
    const lVal = num('inductance_mh', 20);
    const cVal = num('capacitance_uf', 100);
    const f0 = (1 / (2 * Math.PI * Math.sqrt((lVal * 1e-3) * (cVal * 1e-6)))).toFixed(1);

    title = `Series RLC Schematic (R=${rVal}Ω, L=${lVal}mH, C=${cVal}μF, f₀=${f0}Hz)`;
    dimensions = [
      { callout: 'Source Excitation', value: vStr },
      { callout: 'Resistor (R)', value: `${rVal} Ω`, tolerance: '1% wirewound' },
      { callout: 'Inductor (L)', value: `${lVal} mH` },
      { callout: 'Capacitor (C) & f₀', value: `${cVal} μF (Resonance f₀ = ${f0} Hz)` },
    ];
    cadGuidance = [
      'Separate high-di/dt inductive loop trace area on PCB layout; place X7R/film decoupling close to ground return.',
    ];
    drawingNotesOut = ['IEC/IEEE 315 passive symbol conventions; confirm capacitor RMS ripple current & AC voltage rating.'];

    svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 640 280" width="640" height="280">
  <rect width="640" height="280" fill="#0B1018"/>
  <circle cx="95" cy="140" r="26" fill="none" stroke="#34D399" stroke-width="2.5"/>
  <text x="72" y="145" fill="#6EE7B7" font-family="monospace" font-size="11">${vStr}</text>
  <polyline points="95,114 95,70 190,70" fill="none" stroke="#94A3B8" stroke-width="2"/>
  <polyline points="190,70 200,58 212,82 224,58 236,82 248,58 260,70" fill="none" stroke="#60A5FA" stroke-width="2.5"/>
  <text x="200" y="46" fill="#93C5FD" font-family="monospace" font-size="12">R = ${rVal} Ω</text>
  <line x1="260" y1="70" x2="320" y2="70" stroke="#94A3B8" stroke-width="2"/>
  <path d="M 320 70 Q 332 48 344 70 Q 356 48 368 70 Q 380 48 392 70 Q 404 48 416 70" fill="none" stroke="#F59E0B" stroke-width="2.5"/>
  <text x="336" y="46" fill="#FCD34D" font-family="monospace" font-size="12">L = ${lVal} mH</text>
  <polyline points="416,70 535,70 535,126" fill="none" stroke="#94A3B8" stroke-width="2"/>
  <line x1="513" y1="126" x2="557" y2="126" stroke="#A78BFA" stroke-width="3"/>
  <line x1="513" y1="146" x2="557" y2="146" stroke="#A78BFA" stroke-width="3"/>
  <text x="435" y="141" fill="#C4B5FD" font-family="monospace" font-size="12">C = ${cVal} μF</text>
  <polyline points="535,146 535,215 95,215 95,166" fill="none" stroke="#94A3B8" stroke-width="2"/>
  <text x="210" y="248" fill="#CBD5E1" font-family="monospace" font-size="12">Resonant Frequency f₀ = ${f0} Hz</text>
</svg>`;
  } else {
    // pipe_system
    const pipeMm = num('pipe_mm', 50);
    const lenM = num('length_m', 25);
    const flowLs = num('flow_ls', 4.0);
    const headM = num('head_m', 18);

    title = `Centrifugal Pump & Process Pipe P&ID Schematic (DN${pipeMm}, Q=${flowLs} L/s)`;
    dimensions = [
      { callout: 'Pipe Bore (ID)', value: `${pipeMm} mm` },
      { callout: 'Run Length (L)', value: `${lenM} m` },
      { callout: 'Design Flow (Q)', value: `${flowLs} L/s` },
      { callout: 'Total Head (H)', value: `${headM} m` },
    ];
    cadGuidance = [
      'Route pump suction horizontal or sloping gently down toward pump nozzle with concentric/eccentric top-flat reducer to prevent air pockets.',
    ];
    drawingNotesOut = ['Include isolation gate/ball valves and swing check valve immediately downstream of pump discharge flange.'];

    svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 640 280" width="640" height="280">
  <rect width="640" height="280" fill="#0B1018"/>
  <rect x="65" y="130" width="80" height="90" fill="#1E293B" stroke="#60A5FA" stroke-width="2"/>
  <text x="80" y="180" fill="#93C5FD" font-family="monospace" font-size="11">SUMP</text>
  <line x1="145" y1="190" x2="255" y2="190" stroke="#38BDF8" stroke-width="6"/>
  <circle cx="285" cy="190" r="28" fill="#0F172A" stroke="#34D399" stroke-width="3"/>
  <polygon points="274,178 302,190 274,202" fill="#34D399"/>
  <text x="260" y="238" fill="#6EE7B7" font-family="monospace" font-size="11">PUMP H=${headM}m</text>
  <polyline points="285,162 285,82 540,82" fill="none" stroke="#38BDF8" stroke-width="6"/>
  <polygon points="555,82 536,72 536,92" fill="#38BDF8"/>
  <text x="330" y="64" fill="#E2E8F0" font-family="monospace" font-size="12">ID=${pipeMm}mm · L=${lenM}m · Q=${flowLs} L/s</text>
  <circle cx="340" cy="82" r="14" fill="#0B1018" stroke="#F59E0B" stroke-width="2"/>
  <text x="331" y="86" fill="#FCD34D" font-family="monospace" font-size="11">PI</text>
</svg>`;
  }

  return {
    ok: true,
    kind,
    title,
    svg,
    dimensions,
    cad_guidance: cadGuidance,
    drawing_notes: drawingNotesOut,
    interpretation: drawingNotes ? interpretDrawingNotes(drawingNotes) : undefined,
  };
}
