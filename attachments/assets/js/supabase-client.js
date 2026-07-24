// Zanka Group - Supabase Client Initialization

const SUPABASE_URL = 'https://blhjlsddmwxjchjlfnhk.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImJsaGpsc2RkbXd4amNoamxmbmhrIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODQzMDkwMjcsImV4cCI6MjA5OTg4NTAyN30.Qrax77f9M1Ov7ycft-PYvzEUstVqe-c0ExOoeRO_DbM';

// Creates the actual client instance auth.js expects at window.supabaseClient
window.supabaseClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);