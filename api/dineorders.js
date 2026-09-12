const express = require("express");
const db = require("../utils/database");
const { authMiddleware } = require("../middleware/auth");
const router = express.Router();
router.use(authMiddleware);
router.get("/", async (req,res)=>{
  try{
    const st = req.query.status;
    let q = "SELECT * FROM pos_orders WHERE tenant_id=?";
    const p = [req.user.tenant_id];
    if(st){ q += " AND order_status=?"; p.push(st); }
    q += " ORDER BY created_at DESC LIMIT 200";
    const r = await db.query(q,p);
    res.json({success:true,data:r});
  }catch(e){ res.status(500).json({success:false,message:"Error fetching orders"}); }
});
router.put("/:code/status", async (req,res)=>{
  try{
    await db.query("UPDATE pos_orders SET order_status=? WHERE tenant_id=? AND order_code=?",[req.body.status,req.user.tenant_id,req.params.code]);
    res.json({success:true});
  }catch(e){ res.status(500).json({success:false,message:"Error updating order"}); }
});
module.exports = router;
