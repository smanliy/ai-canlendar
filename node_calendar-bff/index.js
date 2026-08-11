const express = require('express')
const authRoutes = require('./modules/auth/auth.route')

const app = express()
const port = 3000

app.use(express.json())
app.use('/api/auth', authRoutes)
app.get('/', (req, res) => {
    res.send('Hello ! good luck to you~~~')
})

app.use('/api/auth', authRoutes)

app.listen(port, () => {
    console.log(`Example app listening at http://localhost:${port}`)
})
