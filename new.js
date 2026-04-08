const autocannon = require('autocannon');

autocannon({
    url: 'http://localhost:5000/api/auth/login',
    method: 'POST',
    connections: 20,
    duration: 20,
    headers: {
        'Content-Type': 'application/json'
    },
    body: JSON.stringify({
        phone: '+237673927172',
        password: 'speakers'
    })
}, console.log);