const BREVO_API_KEY = process.env.BREVO_API_KEY || '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';

async function sendCredentialsEmail({
    name,
    email,
    businessName,
    username,
    password,
    accountLabel = 'admin'
}) {
    const safeBusinessName = businessName || 'your store';
    const safeLabel = accountLabel.toLowerCase();

    const response = await fetch('https://api.brevo.com/v3/smtp/email', {
        method: 'POST',
        headers: {
            accept: 'application/json',
            'api-key': BREVO_API_KEY,
            'content-type': 'application/json'
        },
        body: JSON.stringify({
            sender: {
                name: 'Scanex POS',
                email: 'scanex@scanexsystems.com'
            },
            to: [
                {
                    email,
                    name
                }
            ],
            subject: `Your ${safeBusinessName} ${safeLabel} login for Scanex POS`,
            htmlContent: `
                <html>
                    <body>
                        <p>Hello ${name},</p>
                        <p>Your ${safeLabel} login for <strong>${safeBusinessName}</strong> is ready.</p>
                        <p>Use the following credentials to sign in:</p>
                        <p><strong>Username:</strong> ${username}</p>
                        <p><strong>Password:</strong> ${password}</p>
                        <p>Please log in and change your password after your first login.</p>
                    </body>
                </html>
            `
        })
    });

    if (!response.ok) {
        const errorPayload = await response.text();
        throw new Error(`Brevo email send failed: ${errorPayload}`);
    }

    return response.json();
}

module.exports = { sendCredentialsEmail };
