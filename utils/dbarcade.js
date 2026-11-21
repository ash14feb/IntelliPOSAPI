class Dbarcade {
    constructor() {
        this.baseUrl = process.env.OCI_API_URL || 'https://db.unifylead.com';
        this.apiKey = process.env.OCI_API_KEY;
        this.dbName = process.env.DB_NAME || 'ScanexPOS';

        console.log(this.dbName);
    }

    async query(sql, params = []) {
        try {
            const response = await fetch(`${this.baseUrl}/api/sql`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'x-api-key': this.apiKey,
                    'x-db-name': this.dbName
                },
                body: JSON.stringify({ sql, params })
            });

            const payload = await response.json();

            if (!response.ok) {
                throw new Error(payload.error || `Bridge request failed with ${response.status}`);
            }

            return payload.data;
        } catch (error) {
            console.error('Database query error:', error);
            throw error;
        }
    }

    async getConnection() {
        throw new Error('Direct pool connections are handled by the OCI bridge; use db.query(sql, params) instead.');
    }
}

module.exports = new Dbarcade();