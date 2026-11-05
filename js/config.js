// Public configuration. These values are SAFE to publish:
// the publishable key only identifies the project — every table is locked
// by row-level security and needs a staff login. Never put the secret key here.
window.ROBOSTORE_CONFIG = Object.freeze({
  supabaseUrl: 'https://dnvluspfcebqvulrdqoi.supabase.co',
  supabaseKey: 'sb_publishable_GK2V_VeITWjs2pYQ75nvtw_Llv4VN5b',
  // Usernames are turned into username@<loginDomain> for Supabase Auth (never emailed).
  loginDomain: 'robostore.invalid',
});
