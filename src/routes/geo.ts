import { Router } from 'express'

const router = Router()

const GOOGLE_API_KEY = process.env.GOOGLE_MAPS_API_KEY

router.get('/autocomplete', async (req, res) => {
  const input = String(req.query.input ?? '').trim()
  if (!input) return res.status(400).json({ error: 'input required' })
  if (!GOOGLE_API_KEY) return res.status(500).json({ error: 'missing api key' })

  const url = new URL('https://maps.googleapis.com/maps/api/place/autocomplete/json')
  url.searchParams.set('input', input)
  url.searchParams.set('key', GOOGLE_API_KEY)
  url.searchParams.set('components', 'country:ph')
  url.searchParams.set('types', 'geocode')
  url.searchParams.set('language', 'en')

  let data: any
  try {
    const response = await fetch(url)
    data = await response.json()
  } catch (err) {
    return res.status(502).json({ error: 'upstream_error', message: String(err) })
  }

  if (data.status !== 'OK') {
    return res.status(502).json({ error: data.status, message: data.error_message })
  }

  const items = (data.predictions ?? []).map((p: any) => ({
    placeId: p.place_id,
    description: p.description
  }))

  return res.json({ items })
})

router.get('/reverse', async (req, res) => {
  const lat = Number(req.query.lat)
  const lng = Number(req.query.lng)

  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    return res.status(400).json({ error: 'lat and lng required' })
  }
  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) {
    return res.status(400).json({ error: 'lat/lng out of range' })
  }
  if (!GOOGLE_API_KEY) return res.status(500).json({ error: 'missing api key' })

  const url = new URL('https://maps.googleapis.com/maps/api/geocode/json')
  url.searchParams.set('latlng', `${lat},${lng}`)
  url.searchParams.set('key', GOOGLE_API_KEY)
  url.searchParams.set('language', 'en')

  let data: any
  try {
    const response = await fetch(url)
    data = await response.json()
  } catch (err) {
    return res.status(502).json({ error: 'upstream_error', message: String(err) })
  }

  if (data.status === 'ZERO_RESULTS') {
    return res.json({ address: '', lat, lng })
  }
  if (data.status !== 'OK') {
    return res.status(502).json({ error: data.status, message: data.error_message })
  }

  const first = data.results?.[0]
  return res.json({
    address: first?.formatted_address ?? '',
    placeId: first?.place_id,
    lat,
    lng
  })
})

router.get('/details', async (req, res) => {
  const placeId = String(req.query.placeId ?? '').trim()
  if (!placeId) return res.status(400).json({ error: 'placeId required' })
  if (!GOOGLE_API_KEY) return res.status(500).json({ error: 'missing api key' })

  const url = new URL('https://maps.googleapis.com/maps/api/place/details/json')
  url.searchParams.set('place_id', placeId)
  url.searchParams.set('key', GOOGLE_API_KEY)
  url.searchParams.set('fields', 'formatted_address,geometry/location,name')

  let data: any
  try {
    const response = await fetch(url)
    data = await response.json()
  } catch (err) {
    return res.status(502).json({ error: 'upstream_error', message: String(err) })
  }

  if (data.status !== 'OK') {
    return res.status(502).json({ error: data.status, message: data.error_message })
  }

  const result = data.result
  return res.json({
    placeId,
    address: result.formatted_address,
    name: result.name,
    lat: result.geometry.location.lat,
    lng: result.geometry.location.lng
  })
})

router.get('/route', async (req, res) => {
  const originLat = Number(req.query.originLat)
  const originLng = Number(req.query.originLng)
  const destinationLat = Number(req.query.destinationLat)
  const destinationLng = Number(req.query.destinationLng)

  if (
    !Number.isFinite(originLat) ||
    !Number.isFinite(originLng) ||
    !Number.isFinite(destinationLat) ||
    !Number.isFinite(destinationLng)
  ) {
    return res.status(400).json({ error: 'originLat, originLng, destinationLat, destinationLng required' })
  }

  if (!GOOGLE_API_KEY) return res.status(500).json({ error: 'missing api key' })

  const url = new URL('https://maps.googleapis.com/maps/api/directions/json')
  url.searchParams.set('origin', `${originLat},${originLng}`)
  url.searchParams.set('destination', `${destinationLat},${destinationLng}`)
  url.searchParams.set('mode', 'driving')
  url.searchParams.set('alternatives', 'false')
  url.searchParams.set('key', GOOGLE_API_KEY)

  let data: any
  try {
    const response = await fetch(url)
    data = await response.json()
  } catch (err) {
    return res.status(502).json({ error: 'upstream_error', message: String(err) })
  }

  if (data.status !== 'OK') {
    return res.status(502).json({ error: data.status, message: data.error_message })
  }

  const route = data.routes?.[0]
  const leg = route?.legs?.[0]
  if (!route || !leg) {
    return res.status(502).json({ error: 'INVALID_ROUTE_RESPONSE' })
  }

  return res.json({
    polyline: route.overview_polyline?.points ?? '',
    distanceMeters: leg.distance?.value ?? 0,
    durationSeconds: leg.duration?.value ?? 0
  })
})

export default router
