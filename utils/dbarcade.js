
const mysql = require('mysql2/promise');

class Dbarcade {
    constructor() {
        this.pool = mysql.createPool({
            host: 'apossql-2f34d94b-immerzo2025-944f.k.aivencloud.com',
            user: 'avnadmin',
            password: 'AVNS_NV-d9DjQC4zCOYg2vhv',
            database: 'ScanexPOS',
            port: 16240,
            ssl: {
                rejectUnauthorized: false,  // CHANGE THIS LINE - Accept self-signed certs
                ca: `-----BEGIN CERTIFICATE-----
MIIEUDCCArigAwIBAgIUEdYKvYWSvSAsPC2RKN97HvMoyzQwDQYJKoZIhvcNAQEM
BQAwQDE+MDwGA1UEAww1NzUwYmQ5MzQtM2IwZS00ODIxLWFhYTMtN2Y1ZTVkNWRi
MzkyIEdFTiAxIFByb2plY3QgQ0EwHhcNMjUxMTIyMDc1OTE4WhcNMzUxMTIwMDc1
OTE4WjBAMT4wPAYDVQQDDDU3NTBiZDkzNC0zYjBlLTQ4MjEtYWFhMy03ZjVlNWQ1
ZGIzOTIgR0VOIDEgUHJvamVjdCBDQTCCAaIwDQYJKoZIhvcNAQEBBQADggGPADCC
AYoCggGBAK/R7tb3qIGwjM55kvEJElcqEPRiUQaXQTkzvQG3u5e6XEGHySLgCT1X
/Uph/23eCs2MBkX+gJ8VrF4sr1CFQsfnEQOYsLo3t7I0KJCe5GCCNxgH/uFH959X
PZqUcdlJ83KsmTbJafrujkw9gqSIAo+ix0OPUi3R03dlXsK1LP51hRdzCxx7cA/P
YoxyssztS8FiBUZCi1WoBvgHwdZDjpUd6H97naTrR6eHsZBfeHWfj/tWHw3pGiMo
cv8ZBPT32a14Ch1H9LWjdQ4qk54QUND9M5faNfhr8ba4BB0ly9+EOvGrKr5DsKx6
FwN/hwl54PtUP1p/UNgCvyHOkW5GVOTVWE/Capg0PzgHYcDQrpW5623Q9vTGGFv4
SRquY16ENFTF7VTIIWO27otq9l90F0D7tIpnttrEh0GzgrQvnctkhm8wqxrLJJvR
+550JsFupnsySkX/CqxvU8EhfKPlQOGKR10izho9m/5P8Yd2Dd11w8KlUXfgF1SA
ZYw+TOsxUwIDAQABo0IwQDAdBgNVHQ4EFgQUJ3w+VCPzb+LoVlv/aETvjFXJXYIw
EgYDVR0TAQH/BAgwBgEB/wIBADALBgNVHQ8EBAMCAQYwDQYJKoZIhvcNAQEMBQAD
ggGBAHCb1UG7YBgn2a+wDAL5x3RotZeV410IWIGG5INDuimui78p7qtUR865JbyK
xRCyl6nyNQmOtdYr12X9ZIQWGG04ri3PSHqo6it6vym4eyDsRn0IEbdK/emEXwn/
Ju8rXOLacaAgJ2u160t7lCgV0wWq90vK8UpPgzvdscfoaqN8tyZztWrfBgpY9Wl2
Jkfy9IhPnVITENsAJtayI8qJmuHfNS9Bvz9tEOVoLXQRRPT1wZt9nMOs3uMZeqhd
d24ne9KvCJ4gbsJ6XQ2HeWC3uQ/jYSzLGoYimCN6w4Be2Rjj/zoR8hTYbv1fcMv9
AiBEXtS2V1ZQEwEXD1Y1bHN2jKyab8O2Yz9eyt4FC4McHXZeCr+vjnVaWsZfBPNn
tDuGdN66NNljilaXzbJO2KOOAVCUAKANPNmyX4mBFhURYhFuvT02GE3oTXk3qHQ4
CnMiHQIjqoBHiryoL0Prz9YOh5JRD/kXn2pMB7US4mKiLtGg7ZGdpkFuG/W4DK95
R4WgTg==
-----END CERTIFICATE-----`
            },
            waitForConnections: true,
            connectionLimit: 10,
            queueLimit: 0
        });

        // For debugging
        console.log(process.env.DB_NAME);
    }

    async query(sql, params) {
        try {
            const [results] = await this.pool.execute(sql, params);
            return results;
        } catch (error) {
            console.error('Database query error:', error);
            throw error;
        }
    }

    async getConnection() {
        return await this.pool.getConnection();
    }
}

module.exports = new Dbarcade();