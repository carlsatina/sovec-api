import express from 'express'
import cors from 'cors'

import authRoutes from './routes/auth.js'
import userRoutes from './routes/users.js'
import bookingRoutes from './routes/bookings.js'
import rideRoutes from './routes/rides.js'
import paymentRoutes from './routes/payments.js'
import promoRoutes from './routes/promos.js'
import rewardRoutes from './routes/rewards.js'
import notificationRoutes from './routes/notifications.js'
import supportRoutes from './routes/support.js'
import driverAppRoutes from './routes/driver-applications.js'
import geoRoutes from './routes/geo.js'
import driverRoutes from './routes/drivers.js'
import adminRoutes from './routes/admin.js'

const app = express()

app.use(cors())
app.use(express.json())

app.get('/health', (_req, res) => res.json({ ok: true }))

app.use('/auth', authRoutes)
app.use('/users', userRoutes)
app.use('/bookings', bookingRoutes)
app.use('/rides', rideRoutes)
app.use('/payments', paymentRoutes)
app.use('/promos', promoRoutes)
app.use('/rewards', rewardRoutes)
app.use('/notifications', notificationRoutes)
app.use('/support', supportRoutes)
app.use('/driver-applications', driverAppRoutes)
app.use('/geo', geoRoutes)
app.use('/drivers', driverRoutes)
app.use('/admin', adminRoutes)

export default app
