const express = require('express');
const crypto = require('crypto');
const db = require('../utils/database');
const { authMiddleware } = require('../middleware/auth');
const router = express.Router();

const newMenuCode = () => crypto.randomBytes(8).toString('hex');

async function ensureMenuCodeColumn() {
    try {
        await db.query('SELECT menu_code FROM pos_tables LIMIT 1');
        return true;
    } catch (e) {
        if (e && (e.code === 'ER_BAD_FIELD_ERROR' || (e.message || '').includes('Unknown column'))) return false;
        throw e;
    }
}

// ---- Public menu for a table (no auth): only menu items are exposed ----
router.get('/menu/:code', async (req, res) => {
    try {
        if (!(await ensureMenuCodeColumn())) {
            return res.status(500).json({ success: false, message: 'Table menu links are not set up yet' });
        }
        const tables = await db.query(
            'SELECT id, tenant_id, table_no, seats, menu_code FROM pos_tables WHERE menu_code = ? AND is_active = 1 LIMIT 1',
            [req.params.code]
        );
        if (tables.length === 0) {
            return res.status(404).json({ success: false, message: 'Menu link not found' });
        }
        const table = tables[0];

        let settings = null;
        try {
            const srows = await db.query(
                'SELECT restaurant_name, currency_symbol FROM pos_settings WHERE tenant_id = ? LIMIT 1',
                [table.tenant_id]
            );
            settings = srows[0] || null;
        } catch (e) { /* settings optional */ }

        let items = [];
        try {
            items = await db.query(
                `SELECT p.id, p.name, p.price, p.image_url, c.name AS category_name
                 FROM pos_products p
                 INNER JOIN pos_categories c ON c.id = p.category_id
                 WHERE p.tenant_id = ? AND c.tenant_id = ? AND p.is_active = 1 AND c.is_active = 1
                 ORDER BY c.sort_order ASC, c.name ASC, p.sort_order ASC, p.name ASC`,
                [table.tenant_id, table.tenant_id]
            );
        } catch (e) {
            return res.status(500).json({ success: false, message: 'Error loading menu' });
        }

        res.json({
            success: true,
            data: {
                table: { table_no: table.table_no, seats: table.seats },
                restaurantName: settings?.restaurant_name || 'Our Menu',
                currencySymbol: settings?.currency_symbol || 'Rs.',
                menuItems: items.map(r => ({
                    id: String(r.id),
                    name: r.name,
                    price: Number(r.price),
                    image: r.image_url || '',
                    category: r.category_name
                }))
            }
        });
    } catch (e) {
        console.error('Public table menu error:', e);
        res.status(500).json({ success: false, message: 'Error loading menu' });
    }
});

router.use(authMiddleware);
// floors (kept for backwards compatibility; UI no longer uses them)
router.get('/floors', async (req,res)=>{ try{ const r=await db.query('SELECT * FROM pos_floors WHERE tenant_id=? AND is_active=1 ORDER BY sort_order,name',[req.user.tenant_id]); res.json({success:true,data:r}); }catch(e){ res.status(500).json({success:false,message:'Error fetching floors'}); } });
router.post('/floors', async (req,res)=>{ try{ const r=await db.query('INSERT INTO pos_floors (tenant_id,name,sort_order) VALUES (?,?,?)',[req.user.tenant_id,req.body.name,req.body.sort_order||0]); res.status(201).json({success:true,data:{id:r.insertId,...req.body}}); }catch(e){ res.status(500).json({success:false,message:'Error creating floor'}); } });
// tables
router.get('/', async (req,res)=>{
    try{
        const hasCode = await ensureMenuCodeColumn();
        const r=await db.query(
            'SELECT t.*,f.name as floor_name FROM pos_tables t LEFT JOIN pos_floors f ON f.id=t.floor_id WHERE t.tenant_id=? AND t.is_active=1 ORDER BY t.table_no',
            [req.user.tenant_id]
        );
        // Backfill missing menu codes so every table gets a unique link.
        if (hasCode) {
            for (const t of r) {
                if (!t.menu_code) {
                    const code = newMenuCode();
                    try {
                        await db.query('UPDATE pos_tables SET menu_code=? WHERE tenant_id=? AND id=?', [code, req.user.tenant_id, t.id]);
                        t.menu_code = code;
                    } catch (e) { /* ignore duplicate race */ }
                }
            }
        }
        res.json({success:true,data:r});
    } catch(e){ res.status(500).json({success:false,message:'Error fetching tables'}); }
});
router.post('/', async (req,res)=>{
    try{
        const {table_no,seats}=req.body;
        if(!table_no || !String(table_no).trim()) return res.status(400).json({success:false,message:'table name required'});
        const hasCode = await ensureMenuCodeColumn();
        if (hasCode) {
            const code = newMenuCode();
            const r=await db.query('INSERT INTO pos_tables (tenant_id,floor_id,table_no,seats,menu_code) VALUES (?,?,?,?,?)',[req.user.tenant_id,null,String(table_no).trim(),Number(seats)||4,code]);
            return res.status(201).json({success:true,data:{id:r.insertId,menu_code:code}});
        }
        const r=await db.query('INSERT INTO pos_tables (tenant_id,floor_id,table_no,seats) VALUES (?,?,?,?)',[req.user.tenant_id,null,String(table_no).trim(),Number(seats)||4]);
        res.status(201).json({success:true,data:{id:r.insertId}});
    } catch(e){ res.status(500).json({success:false,message:'Table exists or error'}); }
});
router.put('/:id/status', async (req,res)=>{ try{ await db.query('UPDATE pos_tables SET status=?,current_order_code=? WHERE tenant_id=? AND id=?',[req.body.status||'FREE',req.body.current_order_code||null,req.user.tenant_id,req.params.id]); res.json({success:true}); }catch(e){ res.status(500).json({success:false,message:'Error updating table'}); } });
router.delete('/:id', async (req,res)=>{ try{ await db.query('UPDATE pos_tables SET is_active=0 WHERE tenant_id=? AND id=?',[req.user.tenant_id,req.params.id]); res.json({success:true}); }catch(e){ res.status(500).json({success:false,message:'Error deleting table'}); } });
module.exports = router;
