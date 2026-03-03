export const API_BASE_URL = import.meta.env.VITE_API_URL || 'http://localhost:5000'

export const apiUrl = (path) => {
    if (path.startsWith('http')) return path
    return `${API_BASE_URL}${path}`
}
