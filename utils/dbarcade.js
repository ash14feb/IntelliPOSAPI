const SESSION_PATH = '/api/session';

// Drop-in stand-in for a mysql2 pooled connection. Each method is one HTTP
// call to the bridge, which keeps the real connection (and its transaction)
// open server-side under this session id.
class BridgeConnection {
    constructor(db, sessionId) {
        this.db = db;
        this.sessionId = sessionId;
        this.released = false;
    }

    async _call(action, body = {}) {
        if (this.released) {
            throw new Error('Connection has been released');
        }
        return this.db._request('POST', `${SESSION_PATH}/${this.sessionId}/${action}`, body);
    }

    async execute(sql, params = []) {
        const rows = await this._call('execute', { sql, params });
        // mysql2 returns [rows, fields]; callers only use rows.
        return [rows, undefined];
    }

    async query(sql, params = []) {
        return this.execute(sql, params);
    }

    async beginTransaction() {
        await this._call('begin');
    }

    async commit() {
        await this._call('commit');
    }

    async rollback() {
        await this._call('rollback');
    }

    async release() {
        if (this.released) return;
        this.released = true;
        try {
            await this.db._request('POST', `${SESSION_PATH}/${this.sessionId}/release`, {});
        } catch (error) {
            console.error('Failed to release DB session:', error.message);
        }
    }

    destroy() {
        return this.release();
    }
}

class Dbarcade {
    constructor() {
        this.baseUrl = process.env.OCI_API_URL || 'https://db.unifylead.com';
        this.apiKey = process.env.OCI_API_KEY;
        this.dbName = process.env.DB_NAME || 'sparkpos';

        console.log(this.dbName);
    }

    async _request(method, path, body) {
        const response = await fetch(`${this.baseUrl}${path}`, {
            method,
            headers: {
                'Content-Type': 'application/json',
                'x-api-key': this.apiKey,
                'x-db-name': this.dbName
            },
            body: body === undefined ? undefined : JSON.stringify(body)
        });

        let payload;
        try {
            payload = await response.json();
        } catch {
            payload = {};
        }

        if (!response.ok) {
            throw new Error(payload.error || `Bridge request failed with ${response.status}`);
        }

        return payload.data;
    }

    async query(sql, params = []) {
        try {
            return await this._request('POST', '/api/sql', { sql, params });
        } catch (error) {
            console.error('Database query error:', error);
            throw error;
        }
    }

    async transaction(statements = []) {
        try {
            return await this._request('POST', '/api/transaction', { statements });
        } catch (error) {
            console.error('Database transaction error:', error);
            throw error;
        }
    }

    async getConnection() {
        const data = await this._request('POST', `${SESSION_PATH}/connect`, {});
        return new BridgeConnection(this, data.sessionId);
    }
}

module.exports = new Dbarcade();
