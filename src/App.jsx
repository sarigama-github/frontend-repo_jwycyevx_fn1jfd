import { useEffect, useMemo, useRef, useState } from 'react'
import io from 'socket.io-client'

const BACKEND_URL = import.meta.env.VITE_BACKEND_URL || ''

function Consent({ onAccept }) {
  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
      <div className="bg-white max-w-lg w-full p-6 rounded shadow">
        <h2 className="text-xl font-semibold mb-2">Consent for Location and Camera</h2>
        <p className="text-sm text-gray-600 mb-4">
          This app collects your location and a selfie to verify attendance. Photos are stored securely and retained for up to 30 days. Teachers and administrators may review them for auditing and dispute resolution. By proceeding, you consent to this processing. You can request a manual override from your teacher if you prefer not to share a selfie.
        </p>
        <button onClick={onAccept} className="bg-blue-600 text-white px-4 py-2 rounded">I Agree</button>
      </div>
    </div>
  )
}

function useAuth() {
  const [token, setToken] = useState(null)
  const [user, setUser] = useState(null)

  const login = async (userId, role, name) => {
    const res = await fetch(`${BACKEND_URL}/api/auth/mock-login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId, role, name })
    })
    const data = await res.json()
    setToken(data.token)
    setUser({ userId, role, name })
  }

  return { token, user, login }
}

function TeacherView({ token, user }) {
  const [consented, setConsented] = useState(false)
  const [session, setSession] = useState(null)
  const [students, setStudents] = useState([])
  const socketRef = useRef(null)

  useEffect(() => {
    if (!session) return
    const s = io(`${BACKEND_URL}/ws`, { path: '/ws/socket.io' })
    socketRef.current = s
    s.emit('join_teacher', { sessionId: session.sessionId })
    s.on('attendance:uploaded', payload => {
      setStudents(prev => {
        const next = [...prev]
        const idx = next.findIndex(x => x.userId === payload.userId)
        if (idx >= 0) {
          next[idx] = { ...next[idx], status: 'uploaded', photoUrl: payload.photoUrl, distance: payload.distance }
        } else {
          next.unshift({ userId: payload.userId, status: 'uploaded', photoUrl: payload.photoUrl, distance: payload.distance })
        }
        return next
      })
    })
    s.on('attendance:overridden', payload => {
      setStudents(prev => prev.map(st => st.userId === payload.userId ? { ...st, status: payload.status } : st))
    })
    return () => { s.disconnect() }
  }, [session])

  const openSession = async () => {
    // capture teacher location
    const pos = await new Promise((resolve, reject) => navigator.geolocation.getCurrentPosition(resolve, reject))
    const lat = pos.coords.latitude
    const lon = pos.coords.longitude
    const res = await fetch(`${BACKEND_URL}/api/session/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ teacherId: user.userId, lat, lon, expiryMinutes: 15, teacherName: user.name })
    })
    const data = await res.json()
    setSession({ sessionId: data.sessionId, startsAt: data.startsAt, expiresAt: data.expiresAt, teacherLocation: data.teacherLocation })
    // initial fetch of teacher view
    const tv = await fetch(`${BACKEND_URL}/api/session/${data.sessionId}/teacher-view`, { headers: { Authorization: `Bearer ${token}` } })
    const tvData = await tv.json()
    setStudents(tvData.students || [])
  }

  const override = async (studentId, status) => {
    if (!session) return
    await fetch(`${BACKEND_URL}/api/session/${session.sessionId}/override`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ userId: studentId, status })
    })
  }

  if (!consented) return <Consent onAccept={() => setConsented(true)} />

  return (
    <div className="p-6 space-y-4">
      <h1 className="text-2xl font-bold">Teacher Dashboard</h1>
      {!session ? (
        <button className="bg-green-600 text-white px-4 py-2 rounded" onClick={openSession}>Open Attendance</button>
      ) : (
        <div className="space-y-3">
          <div className="text-sm text-gray-600">Session: {session.sessionId}</div>
          <div className="grid gap-3">
            {students.map(st => (
              <div key={st.userId} className="border rounded p-3 flex items-center justify-between">
                <div>
                  <div className="font-medium">{st.userId}</div>
                  <div className="text-sm text-gray-600">Distance: {st.distance ?? '-'} m • Status: {st.status}</div>
                </div>
                <div className="flex items-center gap-2">
                  {st.photoUrl && <img src={st.photoUrl} className="w-12 h-12 object-cover rounded" />}
                  <button className="px-2 py-1 bg-blue-600 text-white rounded" onClick={() => override(st.userId, 'overridden_present')}>Mark Present</button>
                  <button className="px-2 py-1 bg-rose-600 text-white rounded" onClick={() => override(st.userId, 'overridden_absent')}>Mark Absent</button>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

function StudentView({ token, user }) {
  const [consented, setConsented] = useState(false)
  const [sessionId, setSessionId] = useState('')
  const [status, setStatus] = useState('idle')
  const [distance, setDistance] = useState(null)
  const [allowed, setAllowed] = useState(false)
  const [file, setFile] = useState(null)

  useEffect(() => {
    if (!sessionId) return
    const s = io(`${BACKEND_URL}/ws`, { path: '/ws/socket.io' })
    s.emit('join_student', { sessionId })
    return () => s.disconnect()
  }, [sessionId])

  const pingLocation = async () => {
    setStatus('checking')
    try {
      const pos = await new Promise((resolve, reject) => navigator.geolocation.getCurrentPosition(resolve, reject))
      const lat = pos.coords.latitude
      const lon = pos.coords.longitude
      const body = { userId: user.userId, lat, lon, clientTimestamp: new Date().toISOString() }
      const res = await fetch(`${BACKEND_URL}/api/session/${sessionId}/location`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify(body)
      })
      const data = await res.json()
      setAllowed(!!data.allowed)
      setDistance(data.distanceMeters)
      setStatus(data.allowed ? 'allowed' : 'too-far')
    } catch (e) {
      setStatus('loc-error')
    }
  }

  const upload = async () => {
    if (!file) return
    const form = new FormData()
    form.append('file', file)
    const res = await fetch(`${BACKEND_URL}/api/session/${sessionId}/selfie`, { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: form })
    const data = await res.json()
    if (data.status === 'uploaded') {
      setStatus('uploaded')
    }
  }

  return (
    <div className="p-6 space-y-4">
      {!consented && <Consent onAccept={() => setConsented(true)} />}
      <h1 className="text-2xl font-bold">Student</h1>
      <div className="flex gap-2 items-end">
        <div>
          <label className="block text-sm">Session ID</label>
          <input className="border px-3 py-2 rounded" placeholder="sess_..." value={sessionId} onChange={e => setSessionId(e.target.value)} />
        </div>
        <button onClick={pingLocation} className="bg-blue-600 text-white px-3 py-2 rounded">Check distance</button>
      </div>
      {status === 'checking' && <div>Checking distance...</div>}
      {status === 'too-far' && <div className="text-amber-700">You are {distance} m away — move closer. <button onClick={pingLocation} className="underline">Retry</button></div>}
      {status === 'loc-error' && <div className="text-rose-700">Location not available. Please enable location and retry.</div>}
      {allowed && (
        <div className="space-y-2">
          <div className="text-green-700">You are within 5 m — Upload selfie</div>
          <input type="file" accept="image/*" capture="user" onChange={e => setFile(e.target.files?.[0] || null)} />
          <button onClick={upload} className="bg-green-600 text-white px-3 py-2 rounded disabled:opacity-50" disabled={!file}>Upload</button>
          {status === 'uploaded' && <div className="text-green-700">Upload successful!</div>}
        </div>
      )}
    </div>
  )
}

function App() {
  const { token, user, login } = useAuth()
  const [role, setRole] = useState('student')
  const [userId, setUserId] = useState('s123')
  const [name, setName] = useState('Alice')

  const doLogin = async () => {
    await login(userId, role, name)
  }

  if (!token) {
    return (
      <div className="min-h-screen p-6">
        <h1 className="text-2xl font-bold mb-4">Attendance MVP</h1>
        <div className="grid gap-3 max-w-md">
          <div>
            <label className="block text-sm">Role</label>
            <select className="border px-3 py-2 rounded w-full" value={role} onChange={e => setRole(e.target.value)}>
              <option value="teacher">Teacher</option>
              <option value="student">Student</option>
            </select>
          </div>
          <div>
            <label className="block text-sm">User ID</label>
            <input className="border px-3 py-2 rounded w-full" value={userId} onChange={e => setUserId(e.target.value)} />
          </div>
          <div>
            <label className="block text-sm">Name</label>
            <input className="border px-3 py-2 rounded w-full" value={name} onChange={e => setName(e.target.value)} />
          </div>
          <button onClick={doLogin} className="bg-blue-600 text-white px-4 py-2 rounded">Login</button>
        </div>
      </div>
    )
  }

  return role === 'teacher' ? <TeacherView token={token} user={user} /> : <StudentView token={token} user={user} />
}

export default App
