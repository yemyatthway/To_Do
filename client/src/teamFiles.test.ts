import { describe, expect, it, vi } from 'vitest'
import type { TeamFile } from './api'
import { TeamFiles } from './teamFiles'

const file = (id: number, more: Partial<TeamFile> = {}) => ({ id, status: 'ready', expires_at: new Date(10 * 60 * 60_000).toISOString(), ...more }) as TeamFile
const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

describe('shared file details', () => {
  it('asks once, in one batch, for everything wanted at the same moment', async () => {
    const fetcher = vi.fn(async (_: number, ids: number[]) => ids.map((id) => file(id)))
    const files = new TeamFiles(fetcher)
    files.want(1, [1, 2])
    files.want(1, [2, 3])
    await flush()
    expect(fetcher).toHaveBeenCalledOnce()
    expect(fetcher).toHaveBeenCalledWith(1, [1, 2, 3])
    files.want(1, [1])
    await flush()
    expect(fetcher).toHaveBeenCalledOnce()
  })

  it('splits very long lists', async () => {
    const fetcher = vi.fn(async () => [])
    new TeamFiles(fetcher).want(1, Array.from({ length: 150 }, (_, i) => i + 1))
    await flush()
    expect(fetcher).toHaveBeenCalledTimes(2)
  })

  it('remembers what no longer exists', async () => {
    const files = new TeamFiles(async () => [file(1)])
    files.want(1, [1, 2])
    await flush()
    expect(files.get(2)).toBe('gone')
    expect(files.isStale(2)).toBe(false)
  })

  it('a failed check tries again later', async () => {
    const fetcher = vi.fn().mockRejectedValueOnce(new Error('down')).mockResolvedValue([file(1)])
    const files = new TeamFiles(fetcher)
    files.want(1, [1])
    await flush()
    expect(files.get(1)).toBeUndefined()
    files.want(1, [1])
    await flush()
    expect(files.get(1)).toMatchObject({ id: 1 })
  })

  it('knows when a file needs checking again', () => {
    const files = new TeamFiles(async () => [], () => 0)
    files.put(file(1))
    files.put(file(2, { status: 'pending' }))
    files.put(file(3, { expires_at: new Date(60_000).toISOString() }))
    expect([files.isStale(1), files.isStale(2), files.isStale(3)]).toEqual([false, true, true])
  })

  it('tells screens when something changes', () => {
    const files = new TeamFiles(async () => [])
    const heard = vi.fn()
    files.subscribe(heard)
    files.put(file(1))
    expect(heard).toHaveBeenCalledOnce()
    expect(files.getVersion()).toBe(1)
  })
})
