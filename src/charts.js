const NS = 'http://www.w3.org/2000/svg';

function node(name, attributes = {}) {
  const element = document.createElementNS(NS, name);
  for (const [key, value] of Object.entries(attributes)) element.setAttribute(key, String(value));
  return element;
}

const INFERRED_COLOR = '#7d968f';

function marker(shape, cx, cy, color) {
  if (shape === 'square') {
    return node('rect', { x: cx - 4.5, y: cy - 4.5, width: 9, height: 9, fill: '#fff', stroke: color, 'stroke-width': 3 });
  }
  // 推定値は形でも区別する（色だけに頼らない）
  if (shape === 'diamond') {
    return node('path', {
      d: `M${cx} ${cy - 6}L${cx + 6} ${cy}L${cx} ${cy + 6}L${cx - 6} ${cy}Z`,
      fill: '#fff', stroke: color, 'stroke-width': 2.5, 'stroke-linejoin': 'round'
    });
  }
  return node('circle', { cx, cy, r: 5, fill: '#fff', stroke: color, 'stroke-width': 3 });
}

function renderChart(container, seriesList, options = {}) {
  if (!container) return;
  container.replaceChildren();
  const series = seriesList.map((item) => ({
    color: '#2d6658', marker: 'circle', ...item,
    points: item.points.filter((point) => Number.isFinite(point.y))
  }));
  const all = series.flatMap((item) => item.points);
  if (!all.length) {
    const empty = document.createElement('div');
    empty.className = 'chart-empty';
    empty.textContent = options.emptyText || '表示できる記録がありません。';
    container.append(empty);
    return;
  }
  const hasLegend = series.length > 1;
  const width = 360;
  const height = hasLegend ? 228 : 210;
  const margin = { left: 42, right: 15, top: hasLegend ? 34 : 16, bottom: 40 };
  const plotWidth = width - margin.left - margin.right;
  const plotHeight = height - margin.top - margin.bottom;
  const minX = Math.min(...all.map((point) => point.x));
  const maxX = Math.max(...all.map((point) => point.x));
  const yMin = options.yMin ?? 0;
  const yMax = options.yMax ?? Math.max(1, ...all.map((point) => point.y));
  const x = (value) => margin.left + (maxX === minX ? plotWidth / 2 : ((value - minX) / (maxX - minX)) * plotWidth);
  const y = (value) => margin.top + plotHeight - ((value - yMin) / Math.max(1, yMax - yMin)) * plotHeight;
  const svg = node('svg', { viewBox: `0 0 ${width} ${height}`, role: 'img', 'aria-label': options.ariaLabel || '記録のグラフ' });
  svg.append(node('line', { x1: margin.left, y1: margin.top, x2: margin.left, y2: margin.top + plotHeight, stroke: '#718482' }));
  svg.append(node('line', { x1: margin.left, y1: margin.top + plotHeight, x2: width - margin.right, y2: margin.top + plotHeight, stroke: '#718482' }));
  for (let i = 0; i <= 5; i++) {
    const value = yMin + ((yMax - yMin) * i / 5);
    const yy = y(value);
    svg.append(node('line', { x1: margin.left, y1: yy, x2: width - margin.right, y2: yy, stroke: '#e3e9e7' }));
    const label = node('text', { x: margin.left - 7, y: yy + 4, 'text-anchor': 'end', fill: '#526765', 'font-size': 11 });
    label.textContent = Number.isInteger(value) ? value : value.toFixed(1);
    svg.append(label);
  }
  if (hasLegend) {
    let legendX = margin.left;
    for (const item of series) {
      const line = node('line', { x1: legendX, y1: 12, x2: legendX + 22, y2: 12, stroke: item.color, 'stroke-width': 3 });
      if (item.dash) line.setAttribute('stroke-dasharray', item.dash);
      svg.append(line, marker(item.marker, legendX + 11, 12, item.color));
      const text = node('text', { x: legendX + 28, y: 16, fill: '#3c4f4d', 'font-size': 12 });
      text.textContent = item.name || '';
      svg.append(text);
      legendX += 28 + 12 * (item.name || '').length + 18;
    }
  }
  for (const item of series) {
    if (item.points.length > 1) {
      const line = node('polyline', {
        points: item.points.map((point) => `${x(point.x)},${y(point.y)}`).join(' '),
        fill: 'none', stroke: item.color, 'stroke-width': 3, 'stroke-linejoin': 'round', 'stroke-linecap': 'round'
      });
      if (item.dash) line.setAttribute('stroke-dasharray', item.dash);
      svg.append(line);
    }
    item.points.forEach((point) => {
      const dot = point.inferred
        ? marker('diamond', x(point.x), y(point.y), INFERRED_COLOR)
        : marker(item.marker, x(point.x), y(point.y), item.color);
      const title = node('title');
      title.textContent = `${point.label || ''} ${point.y}`.trim();
      dot.append(title);
      svg.append(dot);
    });
  }
  const base = series[0].points;
  const firstLabel = node('text', { x: margin.left, y: height - 12, fill: '#526765', 'font-size': 11 });
  firstLabel.textContent = base[0]?.label || '';
  svg.append(firstLabel);
  if (base.length > 1) {
    const lastLabel = node('text', { x: width - margin.right, y: height - 12, 'text-anchor': 'end', fill: '#526765', 'font-size': 11 });
    lastLabel.textContent = base.at(-1).label || '';
    svg.append(lastLabel);
  }
  container.append(svg);
}

export function lineChart(container, points, options = {}) {
  renderChart(container, [{ points }], options);
}

export function comparisonChart(container, seriesList, options = {}) {
  renderChart(container, seriesList, options);
}
