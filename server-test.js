const express = require('express');
const app = express();
app.get('/', (req, res) => res.send('Working!'));
app.listen(3000, '0.0.0.0', () => console.log('Port 3000 open'));