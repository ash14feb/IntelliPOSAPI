CREATE TABLE IF NOT EXISTS pos_tenants (
    tenant_id INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    business_name VARCHAR(150) NOT NULL,
    owner_name VARCHAR(150) NOT NULL,
    owner_email VARCHAR(190) NOT NULL,
    is_active TINYINT(1) NOT NULL DEFAULT 1,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY uq_pos_tenants_owner_email (owner_email)
);

CREATE TABLE IF NOT EXISTS users (
    user_id INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    tenant_id INT UNSIGNED NOT NULL,
    username VARCHAR(100) NOT NULL,
    email VARCHAR(190) NOT NULL,
    password_hash VARCHAR(255) NOT NULL,
    full_name VARCHAR(150) NOT NULL,
    user_type ENUM('admin', 'manager', 'staff') NOT NULL DEFAULT 'staff',
    assigned_store ENUM('arcade', 'dreamcube', 'toys_merch', 'all') NOT NULL DEFAULT 'all',
    is_active TINYINT(1) NOT NULL DEFAULT 1,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY uq_users_username (username),
    KEY idx_users_tenant_email (tenant_id, email),
    KEY idx_users_tenant_id (tenant_id),
    CONSTRAINT fk_users_tenant
        FOREIGN KEY (tenant_id) REFERENCES pos_tenants(tenant_id)
        ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS pos_settings (
    id INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    tenant_id INT UNSIGNED NOT NULL,
    restaurant_name VARCHAR(150) NOT NULL,
    currency_symbol VARCHAR(10) NOT NULL DEFAULT 'Rs.',
    cgst_percent DECIMAL(5,2) NOT NULL DEFAULT 0.00,
    sgst_percent DECIMAL(5,2) NOT NULL DEFAULT 0.00,
    tax_inclusive TINYINT(1) NOT NULL DEFAULT 0,
    enable_kot TINYINT(1) NOT NULL DEFAULT 1,
    printer_connection_type ENUM('bluetooth', 'usb') NOT NULL DEFAULT 'bluetooth',
    paper_width ENUM('2inch', '3inch') NOT NULL DEFAULT '3inch',
    receipt_header VARCHAR(255) NULL,
    receipt_footer VARCHAR(255) NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY uq_pos_settings_tenant_id (tenant_id),
    CONSTRAINT fk_pos_settings_tenant
        FOREIGN KEY (tenant_id) REFERENCES pos_tenants(tenant_id)
        ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS pos_categories (
    id INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    tenant_id INT UNSIGNED NOT NULL,
    name VARCHAR(100) NOT NULL,
    sort_order INT NOT NULL DEFAULT 0,
    is_active TINYINT(1) NOT NULL DEFAULT 1,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY uq_pos_categories_tenant_name (tenant_id, name),
    KEY idx_pos_categories_tenant_id (tenant_id),
    CONSTRAINT fk_pos_categories_tenant
        FOREIGN KEY (tenant_id) REFERENCES pos_tenants(tenant_id)
        ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS pos_products (
    id INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    tenant_id INT UNSIGNED NOT NULL,
    category_id INT UNSIGNED NOT NULL,
    name VARCHAR(150) NOT NULL,
    price DECIMAL(10,2) NOT NULL,
    image_url VARCHAR(500) NULL,
    sort_order INT NOT NULL DEFAULT 0,
    is_active TINYINT(1) NOT NULL DEFAULT 1,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    KEY idx_pos_products_tenant_id (tenant_id),
    KEY idx_pos_products_category_id (category_id),
    CONSTRAINT fk_pos_products_tenant
        FOREIGN KEY (tenant_id) REFERENCES pos_tenants(tenant_id)
        ON DELETE CASCADE,
    CONSTRAINT fk_pos_products_category
        FOREIGN KEY (category_id) REFERENCES pos_categories(id)
        ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS pos_orders (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    tenant_id INT UNSIGNED NOT NULL,
    order_code VARCHAR(40) NOT NULL,
    subtotal DECIMAL(10,2) NOT NULL DEFAULT 0.00,
    discount DECIMAL(10,2) NOT NULL DEFAULT 0.00,
    cgst_amount DECIMAL(10,2) NOT NULL DEFAULT 0.00,
    sgst_amount DECIMAL(10,2) NOT NULL DEFAULT 0.00,
    total_amount DECIMAL(10,2) NOT NULL DEFAULT 0.00,
    payment_mode ENUM('CASH', 'UPI', 'CARD') NOT NULL DEFAULT 'CASH',
    customer_name VARCHAR(150) NULL,
    customer_phone VARCHAR(25) NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY uq_pos_orders_tenant_order_code (tenant_id, order_code),
    KEY idx_pos_orders_tenant_id (tenant_id),
    KEY idx_pos_orders_created_at (created_at),
    CONSTRAINT fk_pos_orders_tenant
        FOREIGN KEY (tenant_id) REFERENCES pos_tenants(tenant_id)
        ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS pos_order_items (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    tenant_id INT UNSIGNED NOT NULL,
    order_id BIGINT UNSIGNED NOT NULL,
    product_id INT UNSIGNED NULL,
    item_name VARCHAR(150) NOT NULL,
    item_category VARCHAR(100) NULL,
    item_image VARCHAR(500) NULL,
    quantity INT NOT NULL DEFAULT 1,
    unit_price DECIMAL(10,2) NOT NULL DEFAULT 0.00,
    line_total DECIMAL(10,2) NOT NULL DEFAULT 0.00,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    KEY idx_pos_order_items_tenant_id (tenant_id),
    KEY idx_pos_order_items_order_id (order_id),
    CONSTRAINT fk_pos_order_items_tenant
        FOREIGN KEY (tenant_id) REFERENCES pos_tenants(tenant_id)
        ON DELETE CASCADE,
    CONSTRAINT fk_pos_order_items_order
        FOREIGN KEY (order_id) REFERENCES pos_orders(id)
        ON DELETE CASCADE,
    CONSTRAINT fk_pos_order_items_product
        FOREIGN KEY (product_id) REFERENCES pos_products(id)
        ON DELETE SET NULL
);

-- Existing database update:
-- ALTER TABLE users ADD COLUMN email VARCHAR(190) NOT NULL DEFAULT '' AFTER username;
-- CREATE INDEX idx_users_tenant_email ON users (tenant_id, email);
--
-- For existing single-tenant databases, backfill one tenant and update old rows with that tenant_id
-- before applying the foreign keys and unique indexes above.

CREATE TABLE IF NOT EXISTS password_reset_tokens (
    id INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    user_id INT UNSIGNED NOT NULL,
    token VARCHAR(64) NOT NULL,
    expires_at TIMESTAMP NOT NULL,
    used TINYINT(1) NOT NULL DEFAULT 0,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY idx_prt_token (token),
    KEY idx_prt_user_id (user_id),
    CONSTRAINT fk_prt_user
        FOREIGN KEY (user_id) REFERENCES users(user_id)
        ON DELETE CASCADE
);
