import { useState, useEffect, useCallback } from 'react'

interface AdminUser {
  userId: string
  githubLogin: string
  avatarUrl: string
  awsConfigured: boolean
  usageCount: number
  usagePeriod: string
  lastLoginAt: string
  isAdmin: boolean
  onboardingCompleted: boolean
  customLimit: number | null
}

interface AdminStats {
  totalUsers: number
  freeUsers: number
  proUsers: number
  totalReviewsThisMonth: number
  topUsers: { login: string; count: number; tier: string }[]
  period: string
}

async function apiFetch(path: string, init?: RequestInit): Promise<Response> {
  return fetch(path, { ...init, credentials: 'include' })
}

function timeAgo(d: string): string {
  if (!d) return 'Never'
  const s = Math.floor((Date.now() - new Date(d).getTime()) / 1000)
  if (s < 60) return 'just now'
  if (s < 3600) return `${Math.floor(s / 60)}m ago`
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`
  return `${Math.floor(s / 86400)}d ago`
}

export default function Admin() {
  const [authorized, setAuthorized] = useState<boolean | null>(null)
  const [users, setUsers] = useState<AdminUser[]>([])
  const [stats, setStats] = useState<AdminStats | null>(null)
  const [loading, setLoading] = useState(true)
  const [actionLoading, setActionLoading] = useState('')
  const [editLimit, setEditLimit] = useState<{ userId: string; value: string } | null>(null)

  const loadData = useCallback(async () => {
    try {
      const [usersRes, statsRes] = await Promise.all([
        apiFetch('/api/admin/users'),
        apiFetch('/api/admin/stats'),
      ])
      if (usersRes.status === 403 || usersRes.status === 401) {
        setAuthorized(false)
        setLoading(false)
        return
      }
      setAuthorized(true)
      const usersData = await usersRes.json()
      const statsData = await statsRes.json()
      setUsers(usersData.users ?? [])
      setStats(statsData)
    } catch {
      setAuthorized(false)
    }
    setLoading(false)
  }, [])

  useEffect(() => { loadData() }, [loadData])

  const toggleAdmin = async (userId: string, current: boolean) => {
    setActionLoading(`admin-${userId}`)
    try {
      await apiFetch(`/api/admin/users/${userId}/admin`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ isAdmin: !current }),
      })
      await loadData()
    } catch {}
    setActionLoading('')
  }

  const saveLimit = async (userId: string) => {
    if (!editLimit) return
    setActionLoading(`limit-${userId}`)
    try {
      await apiFetch(`/api/admin/users/${userId}/limit`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ customLimit: parseInt(editLimit.value, 10) || 5 }),
      })
      setEditLimit(null)
      await loadData()
    } catch {}
    setActionLoading('')
  }

  if (loading) return (
    <div className="admin-boot">
      <div className="admin-logo">Lintellect <span className="admin-accent">Admin</span></div>
      <div className="admin-spinner" />
    </div>
  )

  if (authorized === false) return (
    <div className="admin-boot">
      <div className="admin-logo">Lintellect <span className="admin-accent">Admin</span></div>
      <div className="admin-denied">
        <h2>Access Denied</h2>
        <p>You do not have admin privileges, or you are not logged in.</p>
        <p className="admin-hint">Sign in to the main dashboard first, then return here.</p>
      </div>
    </div>
  )

  return (
    <div className="admin-layout">
      <header className="admin-header">
        <div className="admin-logo">Lintellect <span className="admin-accent">Admin</span></div>
        <span className="admin-period">{stats?.period ?? ''}</span>
      </header>

      <main className="admin-main">
        {stats && (
          <div className="admin-stats-row">
            <div className="admin-stat">
              <div className="admin-stat-num">{stats.totalUsers}</div>
              <div className="admin-stat-label">Total Users</div>
            </div>
            <div className="admin-stat admin-stat-free">
              <div className="admin-stat-num">{stats.freeUsers}</div>
              <div className="admin-stat-label">Free Tier</div>
            </div>
            <div className="admin-stat admin-stat-pro">
              <div className="admin-stat-num">{stats.proUsers}</div>
              <div className="admin-stat-label">Pro (AWS)</div>
            </div>
            <div className="admin-stat admin-stat-reviews">
              <div className="admin-stat-num">{stats.totalReviewsThisMonth}</div>
              <div className="admin-stat-label">Reviews This Month</div>
            </div>
          </div>
        )}

        <div className="admin-panel">
          <h2 className="admin-panel-title">Users</h2>
          <div className="admin-table-wrap">
            <table className="admin-table">
              <thead>
                <tr>
                  <th>User</th>
                  <th>Tier</th>
                  <th>Usage</th>
                  <th>Limit</th>
                  <th>Last Active</th>
                  <th>Admin</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {users.map(u => (
                  <tr key={u.userId} className="admin-user-row">
                    <td>
                      <div className="admin-user-cell">
                        {u.avatarUrl && <img className="admin-avatar" src={u.avatarUrl} alt={u.githubLogin} />}
                        <div>
                          <div className="admin-user-login">{u.githubLogin || u.userId}</div>
                          {!u.onboardingCompleted && <span className="admin-badge admin-badge-pending">Setup pending</span>}
                        </div>
                      </div>
                    </td>
                    <td>
                      <span className={`admin-badge ${u.awsConfigured ? 'admin-badge-pro' : 'admin-badge-free'}`}>
                        {u.awsConfigured ? 'Pro' : 'Free'}
                      </span>
                    </td>
                    <td>
                      <div className="admin-usage-cell">
                        <span>{u.usageCount ?? 0}</span>
                        {!u.awsConfigured && (
                          <div className="admin-usage-bar">
                            <div className="admin-usage-fill" style={{ width: `${Math.min(((u.usageCount ?? 0) / 8) * 100, 100)}%` }} />
                          </div>
                        )}
                      </div>
                    </td>
                    <td>
                      {editLimit?.userId === u.userId ? (
                        <div className="admin-edit-limit">
                          <input type="number" value={editLimit.value} onChange={e => setEditLimit({ ...editLimit, value: e.target.value })} min={0} max={1000} />
                          <button onClick={() => saveLimit(u.userId)} disabled={actionLoading === `limit-${u.userId}`}>Save</button>
                          <button onClick={() => setEditLimit(null)} className="admin-btn-cancel">X</button>
                        </div>
                      ) : (
                        <span className="admin-limit-val" onClick={() => setEditLimit({ userId: u.userId, value: String(u.customLimit ?? 5) })}>
                          {u.customLimit ?? 5}
                        </span>
                      )}
                    </td>
                    <td className="admin-time">{timeAgo(u.lastLoginAt)}</td>
                    <td>
                      {u.isAdmin && <span className="admin-badge admin-badge-admin">Admin</span>}
                    </td>
                    <td>
                      <button
                        className={`admin-action-btn ${u.isAdmin ? 'admin-action-revoke' : 'admin-action-grant'}`}
                        onClick={() => toggleAdmin(u.userId, u.isAdmin)}
                        disabled={actionLoading === `admin-${u.userId}`}
                      >
                        {actionLoading === `admin-${u.userId}` ? '...' : u.isAdmin ? 'Revoke Admin' : 'Grant Admin'}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </main>
    </div>
  )
}
