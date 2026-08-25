# Exclude provider idempotency from the vertical PoC

The vertical PoC excludes provider idempotency, deduplication, and provider-side call caps so repeated physical attempts with the same logical refund identity produce independently observable effects. This deliberately departs from production payment guidance to isolate the retry behavior of the two execution strategies; safety is bounded by execution, observation, DLQ, duration, and spending limits instead. Adding effect suppression later would define a different experimental factor and must not be treated as the same PoC.
