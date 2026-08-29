# Keep business invariants out of the controlled provider

The controlled provider authenticates calls and validates their structure, active trial identity, referenced payment, positive safe-integer amount, and payment currency, but it does not read the approved decision, require the requested identity or amount to match it, or enforce the cumulative refund limit. This deliberate departure from a defensive production provider allows BR-2 and BR-9 violations to occur and be measured by the independent oracle instead of being suppressed at the dependency boundary.
