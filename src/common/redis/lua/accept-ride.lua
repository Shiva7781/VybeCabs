-- KEYS[1] = ride:{rideId}:assigned          -- holds the winning driverId once set (persists)
-- KEYS[2] = ride:{rideId}:round:{n}:offer    -- EXISTS only while this round is open (TTL = timeout window)
-- KEYS[3] = ride:{rideId}:round:{n}:candidates -- SET of driverIds that were actually offered this round
-- ARGV[1] = driverId attempting to accept
--
-- Return codes:
--   1  = SUCCESS, this call is the winner, round closed by this call
--   2  = IDEMPOTENT, this driver already won this ride (safe to treat as success)
--   0  = REJECTED, offer expired / round already closed / another driver already won
--  -1  = REJECTED, this driver was never offered this ride (not a candidate)
--
-- Everything below runs atomically inside Redis - no other client can interleave.

local assignedKey = KEYS[1]
local offerKey = KEYS[2]
local candidatesKey = KEYS[3]
local driverId = ARGV[1]

-- Guard: only drivers who were actually notified for this round may accept.
if redis.call('SISMEMBER', candidatesKey, driverId) == 0 then
  return -1
end

-- Guard: the round must still be open (not expired by TTL, not closed by an earlier winner).
if redis.call('EXISTS', offerKey) == 0 then
  -- Even if the round is closed, if this driver is already the assigned winner
  -- (e.g. a retried/duplicate accept arriving after the round was closed by this
  -- same driver's earlier successful call), treat it as idempotent success.
  local current = redis.call('GET', assignedKey)
  if current == driverId then
    return 2
  end
  return 0
end

-- Atomically try to become the assigned driver. NX guarantees only the first
-- caller across all concurrent/racing requests can succeed.
local ok = redis.call('SET', assignedKey, driverId, 'NX')
if ok then
  -- Close the round immediately so any other accept (even within the TTL window)
  -- fails fast on the EXISTS check above instead of racing further.
  redis.call('DEL', offerKey)
  return 1
end

local current = redis.call('GET', assignedKey)
if current == driverId then
  return 2
end
return 0
