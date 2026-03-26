/** Token bucket rate limiter */
export class TokenBucket {
	private tokens: number
	private lastRefill: number
	private readonly capacity: number
	private readonly refillRate: number // tokens per second

	constructor(capacity: number, refillRate: number) {
		this.capacity = capacity
		this.refillRate = refillRate
		this.tokens = capacity
		this.lastRefill = Date.now()
	}

	/** Try to consume one token. Returns true if allowed, false if rate-limited. */
	consume(): boolean {
		this.refill()
		if (this.tokens >= 1) {
			this.tokens -= 1
			return true
		}
		return false
	}

	private refill(): void {
		const now = Date.now()
		const elapsed = (now - this.lastRefill) / 1000
		this.tokens = Math.min(this.capacity, this.tokens + elapsed * this.refillRate)
		this.lastRefill = now
	}
}
