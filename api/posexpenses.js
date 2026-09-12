const express = require("express");
const db = require("../utils/database");
const { authMiddleware } = require("../middleware/auth");
const router = express.Router();
router.use(authMiddleware);
router.get("/", async (req,res)=>{
  try{
    const r = await db.query("SELECT * FROM pos_expenses WHERE tenant_id=? ORDER BY expense_date DESC LIMIT 200",[req.user.tenant_id]);
    res.json({success:true,data:r});
  }catch(e){ res.status(500).json({success:false,message:"Error fetching expenses"}); }
});
router.post("/", async (req,res)=>{
  try{
    const b = req.body;
    if(!b.expense_date || !b.amount) return res.status(400).json({success:false,message:"date and amount required"});
    const r = await db.query("INSERT INTO pos_expenses (tenant_id,expense_date,category,amount,notes,created_by) VALUES (?,?,?,?,?,?)",[req.user.tenant_id,b.expense_date,b.category||"General",Number(b.amount),b.notes||null,req.user.user_id||null]);
    res.status(201).json({success:true,data:{id:r.insertId}});
  }catch(e){ res.status(500).json({success:false,message:"Error creating expense"}); }
});
module.exports = router;
