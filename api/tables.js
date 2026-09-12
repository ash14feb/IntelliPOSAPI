const express = require('express');
const db = require('../utils/database');
const { authMiddleware } = require('../middleware/auth');
const router = express.Router();
router.use(authMiddleware);
// floors
router.get('/floors', async (req,res)=>{ try{ const r=await db.query('SELECT * FROM pos_floors WHERE tenant_id=? AND is_active=1 ORDER BY sort_order,name',[req.user.tenant_id]); res.json({success:true,data:r}); }catch(e){ res.status(500).json({success:false,message:'Error fetching floors'}); } });
router.post('/floors', async (req,res)=>{ try{ const r=await db.query('INSERT INTO pos_floors (tenant_id,name,sort_order) VALUES (?,?,?)',[req.user.tenant_id,req.body.name,req.body.sort_order||0]); res.status(201).json({success:true,data:{id:r.insertId,...req.body}}); }catch(e){ res.status(500).json({success:false,message:'Error creating floor'}); } });
// tables
router.get('/', async (req,res)=>{ try{ const r=await db.query('SELECT t.*,f.name as floor_name FROM pos_tables t LEFT JOIN pos_floors f ON f.id=t.floor_id WHERE t.tenant_id=? AND t.is_active=1 ORDER BY f.sort_order,t.table_no',[req.user.tenant_id]); res.json({success:true,data:r}); }catch(e){ res.status(500).json({success:false,message:'Error fetching tables'}); } });
router.post('/', async (req,res)=>{ try{ const {floor_id,table_no,seats}=req.body; if(!table_no) return res.status(400).json({success:false,message:'table_no required'}); const r=await db.query('INSERT INTO pos_tables (tenant_id,floor_id,table_no,seats) VALUES (?,?,?,?)',[req.user.tenant_id,floor_id||null,table_no,seats||4]); res.status(201).json({success:true,data:{id:r.insertId}}); }catch(e){ res.status(500).json({success:false,message:'Table exists or error'}); } });
router.put('/:id/status', async (req,res)=>{ try{ await db.query('UPDATE pos_tables SET status=?,current_order_code=? WHERE tenant_id=? AND id=?',[req.body.status||'FREE',req.body.current_order_code||null,req.user.tenant_id,req.params.id]); res.json({success:true}); }catch(e){ res.status(500).json({success:false,message:'Error updating table'}); } });
router.delete('/:id', async (req,res)=>{ try{ await db.query('UPDATE pos_tables SET is_active=0 WHERE tenant_id=? AND id=?',[req.user.tenant_id,req.params.id]); res.json({success:true}); }catch(e){ res.status(500).json({success:false,message:'Error deleting table'}); } });
module.exports = router;

