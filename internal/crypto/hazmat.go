package crypto

// RedactMap returns a copy of m with all values replaced by [REDACTED].
// Use this when logging maps that may contain secret values.
func RedactMap(m map[string]string) map[string]string {
	safe := make(map[string]string, len(m))
	for k := range m {
		safe[k] = "[REDACTED]"
	}
	return safe
}
