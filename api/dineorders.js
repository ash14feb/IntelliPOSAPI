const express = require("express");
const db = require("../utils/database");
const { authMiddleware } = require("../middleware/auth");
const router = express.Router();
router.use(authMiddleware);
router.get("/", async (req,res)=>{
  try{
    const st = req.query.status;
    let q = "SELECT o.*, t.table_no FROM pos_orders o LEFT JOIN pos_tables t ON t.id = o.table_id AND t.tenant_id = o.tenant_id WHERE o.tenant_id=?";
    const p = [req.user.tenant_id];
    if(st){ q += " AND o.order_status=?"; p.push(st); }
    q += " ORDER BY o.created_at DESC LIMIT 200";
    let r;
    try { r = await db.query(q,p); }
    catch(e) { r = await db.query("SELECT * FROM pos_orders WHERE tenant_id=? ORDER BY created_at DESC LIMIT 200", [req.user.tenant_id]); }
    // Attach items for active-table views (best effort, small N)
    try {
      const ids = r.map((o) => o.id);
      if (ids.length) {
        const ph = ids.map(() => '?').join(',');
        const items = await db.query(`SELECT order_id, product_id, item_name, item_category, item_image, quantity, unit_price, line_total FROM pos_order_items WHERE tenant_id=? AND order_id IN (${ph}) ORDER BY id ASC`, [req.user.tenant_id, ...ids]);
        const byOrder = new Map();
        for (const it of items) {
          const arr = byOrder.get(it.order_id) || [];
          arr.push({ id: String(it.product_id ?? ''), name: it.item_name, price: Number(it.unit_price), qty: Number(it.quantity), quantity: Number(it.quantity), category: it.item_category, image: it.item_image });
          byOrder.set(it.order_id, arr);
        }
        r = r.map((o) => ({ ...o, items: byOrder.get(o.id) || [] }));
      }
    } catch {}
    res.json({success:true,data:r});
  }catch(e){ res.status(500).json({success:false,message:"Error fetching orders"}); }
});
router.put("/:code/status", async (req,res)=>{
  try{
    const status = String(req.body.status || '').toUpperCase();
    await db.query("UPDATE pos_orders SET order_status=? WHERE tenant_id=? AND order_code=?",[status,req.user.tenant_id,req.params.code]);
    try {
      const rows = await db.query("SELECT table_id FROM pos_orders WHERE tenant_id=? AND order_code=? LIMIT 1", [req.user.tenant_id, req.params.code]);
      const tid = rows[0]?.table_id;
      if (tid) {
        if (['SERVED','ACTIVE','SAVED'].includes(status)) await db.query("UPDATE pos_tables SET status='OCCUPIED', current_order_code=? WHERE tenant_id=? AND id=?", [req.params.code, req.user.tenant_id, tid]);
        else if (['PAID','COMPLETED'].includes(status)) await db.query("UPDATE pos_tables SET status='FREE', current_order_code=NULL WHERE tenant_id=? AND id=?", [req.user.tenant_id, tid]);
      }
    } catch {}
    res.json({success:true});
  }catch(e){ res.status(500).json({success:false,message:"Error updating order"}); }
});
module.exports = router;
