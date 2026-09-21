// A small dependency-free donut chart, drawn as an inline SVG.
// segments: [{ label, value, color }]
export function renderDonut(svgEl, segments, centerLabel, centerValue) {
  const total = segments.reduce((s, seg) => s + seg.value, 0);
  const r = 42;
  const cx = 50, cy = 50;
  const circumference = 2 * Math.PI * r;

  let offset = 0;
  const parts = segments.map(seg => {
    const frac = total > 0 ? seg.value / total : 0;
    const dash = frac * circumference;
    const circle = `<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="${seg.color}" stroke-width="14"
      stroke-dasharray="${dash} ${circumference - dash}" stroke-dashoffset="${-offset}" transform="rotate(-90 ${cx} ${cy})" />`;
    offset += dash;
    return circle;
  });

  svgEl.setAttribute("viewBox", "0 0 100 100");
  svgEl.setAttribute("role", "img");
  svgEl.setAttribute("aria-label", "Spending by category");
  svgEl.innerHTML = `
    ${total > 0 ? parts.join("") : `<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="var(--border)" stroke-width="14" />`}
    <text x="50" y="47" text-anchor="middle" class="donut-value">${centerValue}</text>
    <text x="50" y="60" text-anchor="middle" class="donut-label">${centerLabel}</text>`;
}
