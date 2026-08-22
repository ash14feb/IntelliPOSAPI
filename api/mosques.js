const express = require('express');
const router = express.Router();
const db = require('../utils/database');
const { authMiddleware, authorize } = require('../middleware/auth');

router.use(authMiddleware);

// @route   POST /api/mosques/import
// @desc    Import mosques from Google Places API
// @access  Private (Admin only) 
router.post('/import', authorize('admin'), async (req, res) => {
    try {
        const {
            latitude,
            longitude,
            radius = 5,
            pageToken = null
        } = req.body;

        if (!latitude || !longitude) {
            return res.status(400).json({
                success: false,
                message: 'latitude and longitude are required'
            });
        }

        const requestBody = {
            textQuery: 'mosques',
            locationBias: {
                circle: {
                    center: { latitude, longitude },
                    radius: radius * 1000
                }
            }
        };

        if (pageToken) {
            requestBody.pageToken = pageToken;
        }

        const response = await fetch(
            'https://places.googleapis.com/v1/places:searchText',
            {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'X-Goog-Api-Key': 'AIzaSyDqgCn1sprsE7M0_lCU9hlwWN92QQBDohk',
                    'X-Goog-FieldMask':
                        'places.id,places.displayName,places.location,places.formattedAddress,places.nationalPhoneNumber,nextPageToken'
                },
                body: JSON.stringify(requestBody)
            }
        );

        const data = await response.json();

        console.log('Google places count:', data.places?.length);


        const places = data.places || [];
        const nextPageToken = data.nextPageToken || null;

        let inserted = 0;

        for (const place of places) {
            const name = place.displayName?.text;
            const languageCode = place.displayName?.languageCode;
            const lat = place.location?.latitude;
            const lng = place.location?.longitude;

            if (!name || !lat || !lng) continue;

            await db.query(
                `INSERT INTO mosques
                (place_id, name, language_code, latitude, longitude, formatted_address, national_phone_number)
                VALUES (?, ?, ?, ?, ?, ?, ?)
                ON DUPLICATE KEY UPDATE
                    name = VALUES(name),
                    formatted_address = VALUES(formatted_address),
                    national_phone_number = VALUES(national_phone_number),
                    updated_at = CURRENT_TIMESTAMP`,
                [
                    place.id || null,
                    name,
                    languageCode || null,
                    lat,
                    lng,
                    place.formattedAddress || '',
                    place.nationalPhoneNumber || null
                ]
            );

            inserted++;
        }

        res.json({
            success: true,
            message: 'Mosques imported successfully',
            inserted_count: inserted,
            next_page_token: nextPageToken
        });

    } catch (error) {
        console.error('Mosque import error:', error.response?.data || error);
        res.status(500).json({
            success: false,
            message: 'Failed to import mosques'
        });
    }
});

module.exports = router;
