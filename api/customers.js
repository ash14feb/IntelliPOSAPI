const express = require('express');
const db = require('../utils/database');
const { authMiddleware } = require('../middleware/auth');
const router = express.Router();
router.use(authMiddleware);
router.get('/', async (req,res)=>{ try{
  const t = req.user.tenant_id;
  const r=await db.query('SELECT * FROM pos_customers WHERE tenant_id=? AND is_active=1 ORDER BY name LIMIT 500',[t]);
  // Merge in customers known only from orders (auto-recorded going forward,
  // aggregated here so past orders show up too). DB rows win on conflict.
  try {
    const orows = await db.query(
      `SELECT customer_phone, customer_name, order_type, total_amount, created_at
       FROM pos_orders
       WHERE tenant_id = ? AND customer_phone IS NOT NULL AND customer_phone <> ''
       ORDER BY created_at DESC LIMIT 5000`,
      [t]
    );
    const { normType } = require('../utils/customerSync');
    const seen = new Set(r.map((c) => String(c.phone || '').trim()));
    const agg = new Map();
    for (const o of orows) {
      const phone = String(o.customer_phone || '').trim();
      if (!phone || seen.has(phone)) continue;
      if (!agg.has(phone)) {
        agg.set(phone, {
          id: `auto-${phone}`,
          name: (o.customer_name || '').trim() || phone,
          phone,
          email: '',
          loyalty_points: 0,
          total_orders: 0,
          total_spent: 0,
          last_order_type: normType(o.order_type),
          last_ordered_at: o.created_at,
          auto: true,
        });
      }
      const a = agg.get(phone);
      a.total_orders += 1;
      a.total_spent = Number(a.total_spent || 0) + Number(o.total_amount || 0);
      if ((o.customer_name || '').trim()) a.name = o.customer_name.trim();
    }
    const merged = [
      ...r.map((c) => ({ ...c, source: String(c.last_order_type || '').toUpperCase() || null, auto: false })),
      ...[...agg.values()].map((a) => ({ ...a, source: String(a.last_order_type || '').toUpperCase() || null })),
    ];
    merged.sort((a, b) => String(a.name || '').localeCompare(String(b.name || '')));
    return res.json({ success: true, data: merged });
  } catch { /* fall back to DB rows only */ }
  res.json({success:true,data:r.map((c) => ({ ...c, source: String(c.last_order_type || '').toUpperCase() || null, auto: false }))});
}catch(e){ res.status(500).json({success:false,message:'Error fetching customers'}); } });
router.post('/', async (req,res)=>{ try{ const {name,phone,email}=req.body; if(!name) return res.status(400).json({success:false,message:'name required'}); const r=await db.query('INSERT INTO pos_customers (tenant_id,name,phone,email) VALUES (?,?,?,?)',[req.user.tenant_id,name,phone||null,email||null]); res.status(201).json({success:true,data:{id:r.insertId,name,phone,email}}); }catch(e){ res.status(500).json({success:false,message:'Error creating customer'}); } });
router.put('/:id/loyalty', async (req,res)=>{ try{ await db.query('UPDATE pos_customers SET loyalty_points=loyalty_points+? WHERE tenant_id=? AND id=?',[Number(req.body.points||0),req.user.tenant_id,req.params.id]); res.json({success:true}); }catch(e){ res.status(500).json({success:false,message:'Error updating loyalty'}); } });
module.exports = router;

