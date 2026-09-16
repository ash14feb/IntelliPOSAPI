const express = require('express');
const ExcelJS = require('exceljs');
const PDFDocument = require('pdfkit');
const db = require('../utils/database');
const { authMiddleware } = require('../middleware/auth');

const router = express.Router();
router.use(authMiddleware);

// Build report rows server-side from DB (tenant-scoped, date range).
// `start`/`end` are YYYY-MM-DD calendar days in the tenant's business timezone.
async function tenantTimezone(tenantId) {
  try {
    const r = await db.query(`SELECT timezone FROM pos_settings WHERE tenant_id=? LIMIT 1`, [tenantId]);
    const tz = r[0]?.timezone;
    if (typeof tz === 'string' && tz) { Intl.DateTimeFormat('en-US', { timeZone: tz }); return tz; }
  } catch {}
  return 'Asia/Kolkata';
}

// Epoch ms of a wall-clock time on `dateStr` in `tz` (DST-safe iteration).
function tzDayStartMs(dateStr, tz) {
  const [Y, M, D] = String(dateStr).split('-').map(Number);
  const off = (ms) => {
    const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).formatToParts(new Date(ms)).map(x => [x.type, x.value]));
    return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour % 24, +p.minute, +p.second) - ms;
  };
  let g = Date.UTC(Y, M - 1, D, 0, 0, 0);
  for (let i = 0; i < 3; i++) g = Date.UTC(Y, M - 1, D, 0, 0, 0) - off(g);
  return g;
}
const fmtInTz = (v, tz, o) => new Intl.DateTimeFormat('en-IN', { ...o, timeZone: tz }).format(new Date(v));
const fmtDT = (v, tz) => fmtInTz(v, tz, { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: true });
const fmtD = (v, tz) => fmtInTz(v, tz, { day: '2-digit', month: 'short', year: 'numeric' });
const fmtT = (v, tz) => fmtInTz(v, tz, { hour: '2-digit', minute: '2-digit', hour12: true });
const dayKey = (v, tz) => new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(v));

async function buildReport(tenantId, report, start, end) {
  const tz = await tenantTimezone(tenantId);
  const todayKey = dayKey(Date.now(), tz);
  const s = start || todayKey;
  const e = end || s;
  const q = async (sql, params) => { try { return await db.query(sql, params); } catch { return []; } };

  // Query by absolute UTC range covering the tz calendar days (correct even
  // when the DB session timezone is UTC and the business day is IST).
  const fromUtc = new Date(tzDayStartMs(s, tz));
  const toUtc = new Date(tzDayStartMs(e, tz) + 86400000 - 1);
  const fmtSql = (d) => d.toISOString().slice(0, 19).replace('T', ' ');

  const orders = await q(
    `SELECT order_code, created_at, subtotal, discount, cgst_amount, sgst_amount, total_amount, payment_mode, customer_name
     FROM pos_orders WHERE tenant_id=? AND created_at BETWEEN ? AND ? ORDER BY created_at DESC LIMIT 2000`,
    [tenantId, fmtSql(fromUtc), fmtSql(toUtc)]);
  const expenses = await q(
    `SELECT expense_date, category, amount, notes FROM pos_expenses WHERE tenant_id=? AND expense_date BETWEEN ? AND ? ORDER BY expense_date DESC LIMIT 2000`,
    [tenantId, s, e]);
  const products = await q(
    `SELECT p.name, c.name AS category, p.price, p.stock, p.low_stock_alert, p.purchase_price
     FROM pos_products p LEFT JOIN pos_categories c ON c.id=p.category_id
     WHERE p.tenant_id=? AND p.is_active=1 ORDER BY p.name LIMIT 2000`,
    [tenantId]);

  let headers = [], rows = [];
  const N = (v) => Number(v || 0).toFixed(2);
  switch (report) {
    case 'sales':
      headers = ['Order ID', 'Date', 'Customer', 'Payment', 'Total'];
      rows = orders.map(o => [o.order_code, fmtDT(o.created_at, tz), o.customer_name || '-', o.payment_mode || 'CASH', N(o.total_amount)]);
      break;
    case 'discount':
      headers = ['Order ID', 'Date', 'Subtotal', 'Discount', 'Total'];
      rows = orders.filter(o => N(o.discount) !== '0.00').map(o => [o.order_code, fmtDT(o.created_at, tz), N(o.subtotal), N(o.discount), N(o.total_amount)]);
      break;
    case 'daybook':
      headers = ['Date', 'Type', 'Description', 'Money In', 'Money Out'];
      rows = [...orders.map(o => [fmtDT(o.created_at, tz), 'Sale', `Order ${o.order_code}`, N(o.total_amount), '0.00']),
        ...expenses.map(x => [String(x.expense_date).slice(0, 10), 'Expense', `${x.category || ''} ${x.notes || ''}`, '0.00', N(x.amount)])];
      break;
    case 'expense':
      headers = ['Date', 'Category', 'Notes', 'Amount'];
      rows = expenses.map(x => [String(x.expense_date).slice(0, 10), x.category || 'General', x.notes || '-', N(x.amount)]);
      break;
    case 'payment-type': {
      const modes = ['CASH', 'UPI', 'CARD'];
      headers = ['Payment Mode', 'Orders', 'Amount'];
      rows = modes.map(m => { const l = orders.filter(o => String(o.payment_mode || 'CASH').toUpperCase() === m); return [m, l.length, N(l.reduce((a, o) => a + Number(o.total_amount || 0), 0))]; });
      break;
    }
    case 'daywise': {
      const m = new Map();
      orders.forEach(o => { const d = dayKey(o.created_at, tz); const c = m.get(d) || { n: 0, s: 0, d: 0, t: 0 }; c.n++; c.s += +o.total_amount || 0; c.d += +o.discount || 0; c.t += (+o.cgst_amount || 0) + (+o.sgst_amount || 0); m.set(d, c); });
      headers = ['Date', 'Orders', 'Sales', 'Discount', 'Tax'];
      rows = [...m.entries()].map(([d, c]) => [d, c.n, N(c.s), N(c.d), N(c.t)]);
      break;
    }
    case 'stock-summary':
      headers = ['Item', 'Category', 'Price', 'Stock', 'Value'];
      rows = products.map(p => [p.name, p.category || '-', N(p.price), p.stock ?? '-', N((+p.stock || 0) * (+p.price || 0))]);
      break;
    case 'low-stock':
      headers = ['Item', 'Stock', 'Alert Level'];
      rows = products.filter(p => p.stock != null && +p.stock <= +(p.low_stock_alert ?? 5)).map(p => [p.name, p.stock, p.low_stock_alert ?? 5]);
      break;
    case 'gstr-1':
      headers = ['Invoice', 'Date', 'Taxable', 'CGST', 'SGST', 'Total'];
      rows = orders.map(o => { const tax = (+o.cgst_amount || 0) + (+o.sgst_amount || 0); return [o.order_code, fmtD(o.created_at, tz), N((+o.total_amount || 0) - tax), N(o.cgst_amount), N(o.sgst_amount), N(o.total_amount)]; });
      break;
    default: {
      // top-selling / item-wise / business-summary need item lines
      const orderIds = orders.map(o => o.order_code);
      let items = [];
      if (orderIds.length) {
        try {
          const ids = await q(`SELECT id, order_code FROM pos_orders WHERE tenant_id=? AND created_at BETWEEN ? AND ?`, [tenantId, fmtSql(fromUtc), fmtSql(toUtc)]);
          const dbIds = ids.map(r => r.id);
          if (dbIds.length) {
            const ph = dbIds.map(() => '?').join(',');
            items = await q(`SELECT item_name, quantity, unit_price FROM pos_order_items WHERE tenant_id=? AND order_id IN (${ph})`, [tenantId, ...dbIds]);
          }
        } catch {}
      }
      if (report === 'top-selling' || report === 'item-wise') {
        const m = new Map();
        items.forEach(i => { const c = m.get(i.item_name) || { q: 0, r: 0 }; c.q += +i.quantity || 0; c.r += (+i.unit_price || 0) * (+i.quantity || 0); m.set(i.item_name, c); });
        const arr = [...m.entries()].sort((a, b) => b[1].q - a[1].q);
        headers = ['Item', 'Qty Sold', 'Revenue'];
        rows = arr.map(([k, v]) => [k, v.q, N(v.r)]);
      } else {
        const sale = orders.reduce((a, o) => a + (+o.total_amount || 0), 0);
        const exp = expenses.reduce((a, x) => a + (+x.amount || 0), 0);
        const disc = orders.reduce((a, o) => a + (+o.discount || 0), 0);
        headers = ['Metric', 'Value'];
        rows = [['Gross Sales', N(sale)], ['Expenses', N(exp)], ['Net', N(sale - exp)], ['Discount', N(disc)], ['Orders', orders.length]];
      }
    }
  }
  return { headers, rows, title: `${report} (${s} to ${e})`, tz };
}

router.get('/:report.:format', async (req, res) => {
  try {
    const { report, format } = req.params;
    const { start, end } = req.query;
    const { headers, rows, title, tz } = await buildReport(req.user.tenant_id, report, start, end);

    if (format === 'xlsx') {
      const wb = new ExcelJS.Workbook();
      const ws = wb.addWorksheet('Report');
      ws.addRow([title]);
      ws.addRow(headers);
      rows.forEach(r => ws.addRow(r));
      ws.getRow(2).font = { bold: true };
      ws.columns.forEach(c => { c.width = 20; });
      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      res.setHeader('Content-Disposition', `attachment; filename="${report}-${start || 'today'}.xlsx"`);
      await wb.xlsx.write(res);
      return res.end();
    }
    if (format === 'pdf') {
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename="${report}-${start || 'today'}.pdf"`);
      // Landscape for wide reports so columns never overlap
      const landscape = headers.length > 4;
      const doc = new PDFDocument({ margin: 36, size: 'A4', layout: landscape ? 'landscape' : 'portrait' });
      doc.pipe(res);
      const pageW = landscape ? 770 : 523; // usable width
      const left = 36;
      // Weight columns by max content length so text cols get more room
      const lens = headers.map((h, i) => Math.max(String(h).length,
        ...rows.slice(0, 200).map(r => String(r[i] ?? '').length)));
      const total = lens.reduce((a, b) => a + b, 0) || 1;
      const widths = lens.map(l => Math.max(55, (l / total) * pageW));
      // normalize to exactly pageW
      const scale = pageW / widths.reduce((a, b) => a + b, 0);
      const colW = widths.map(w => w * scale);
      const rowH = 18;
      const drawRow = (cells, y, isHeader) => {
        let x = left;
        if (isHeader) { doc.rect(left, y, pageW, rowH).fill('#f3f4f6'); doc.fillColor('#111827'); }
        else { if (Math.floor(y / rowH) % 2 === 0) { doc.rect(left, y, pageW, rowH).fill('#fafafa'); } doc.fillColor('#1f2937'); }
        doc.font(isHeader ? 'Helvetica-Bold' : 'Helvetica').fontSize(8);
        cells.forEach((c, i) => {
          const last = i === cells.length - 1;
          const numeric = /^-?[\d,.]+$/.test(String(c ?? '').trim());
          doc.text(String(c ?? ''), x + 4, y + 5, { width: colW[i] - 8, align: numeric ? 'right' : 'left', lineBreak: false, ellipsis: true });
          x += colW[i];
          // vertical gridline
          doc.strokeColor('#e5e7eb').lineWidth(0.5).moveTo(x, y).lineTo(x, y + rowH).stroke();
        });
        // horizontal gridline
        doc.strokeColor('#e5e7eb').lineWidth(0.5).moveTo(left, y + rowH).lineTo(left + pageW, y + rowH).stroke();
        doc.fillColor('#000000');
        return y + rowH;
      };
      doc.fillColor('#111827').fontSize(15).font('Helvetica-Bold').text(title);
      doc.fontSize(9).font('Helvetica').fillColor('#6b7280').text(`Generated ${fmtDT(Date.now(), tz)}  •  ${rows.length} rows`);
      doc.moveDown(0.6);
      let y = doc.y;
      const pageBottom = landscape ? 560 : 800;
      y = drawRow(headers, y, true);
      for (const r of rows.slice(0, 1000)) {
        if (y + rowH > pageBottom) { doc.addPage(); y = 36; y = drawRow(headers, y, true); }
        y = drawRow(r.map(String), y, false);
      }
      doc.end();
      return;
    }
    return res.status(400).json({ success: false, message: 'Use .xlsx or .pdf' });
  } catch (e) {
    console.error('Export error:', e);
    res.status(500).json({ success: false, message: 'Export failed' });
  }
});

module.exports = router;
