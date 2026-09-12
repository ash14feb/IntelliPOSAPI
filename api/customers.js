const express = require('express');
const db = require('../utils/database');
const { authMiddleware } = require('../middleware/auth');
const router = express.Router();
router.use(authMiddleware);
router.get('/', async (req,res)=>{ try{ const r=await db.query('SELECT * FROM pos_customers WHERE tenant_id=? AND is_active=1 ORDER BY name LIMIT 500',[req.user.tenant_id]); res.json({success:true,data:r}); }catch(e){ res.status(500).json({success:false,message:'Error fetching customers'}); } });
router.post('/', async (req,res)=>{ try{ const {name,phone,email}=req.body; if(!name) return res.status(400).json({success:false,message:'name required'}); const r=await db.query('INSERT INTO pos_customers (tenant_id,name,phone,email) VALUES (?,?,?,?)',[req.user.tenant_id,name,phone||null,email||null]); res.status(201).json({success:true,data:{id:r.insertId,name,phone,email}}); }catch(e){ res.status(500).json({success:false,message:'Error creating customer'}); } });
router.put('/:id/loyalty', async (req,res)=>{ try{ await db.query('UPDATE pos_customers SET loyalty_points=loyalty_points+? WHERE tenant_id=? AND id=?',[Number(req.body.points||0),req.user.tenant_id,req.params.id]); res.json({success:true}); }catch(e){ res.status(500).json({success:false,message:'Error updating loyalty'}); } });
module.exports = router;

