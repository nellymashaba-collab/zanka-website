// Zanka Group — Shared profile avatar widget
// Requires supabase-client.js loaded first. Used by admin/owner/tenant/
// partner/investor dashboards, one shared implementation rather than
// five separate copies.
//
// Call initAvatar(containerId, profile) once, after the page has
// resolved the logged-in profile. Renders either the person's photo
// or a Teams/Outlook-style initials circle if they haven't set one,
// and makes it clickable to upload/replace.

const AVATAR_COLORS = ['#1F2A44', '#C89B3C', '#6B8FA3', '#9CA3AF', '#8A6416'];

function avatarInitials(fullName) {
  if (!fullName) return '?';
  const parts = fullName.trim().split(/\s+/);
  return ((parts[0]?.[0] || '') + (parts[1]?.[0] || '')).toUpperCase() || '?';
}

function avatarColor(userId) {
  // Deterministic, not random — the same person always gets the same
  // color rather than it changing on every page load.
  let hash = 0;
  for (let i = 0; i < (userId || '').length; i++) hash = (hash + userId.charCodeAt(i)) % AVATAR_COLORS.length;
  return AVATAR_COLORS[hash];
}

function initAvatar(containerId, profile) {
  const container = document.getElementById(containerId);
  if (!container || !profile) return;

  container.innerHTML = `
    <button id="avatar-trigger" type="button" title="Change profile photo" style="width:40px;height:40px;border-radius:9999px;overflow:hidden;flex-shrink:0;border:2px solid transparent;cursor:pointer;padding:0;display:flex;align-items:center;justify-content:center;transition:border-color .15s;">
      ${profile.avatar_url
        ? `<img src="${profile.avatar_url}" style="width:100%;height:100%;object-fit:cover;">`
        : `<span style="width:100%;height:100%;display:flex;align-items:center;justify-content:center;background:${avatarColor(profile.id)};color:#fff;font-weight:700;font-size:14px;">${avatarInitials(profile.full_name)}</span>`}
    </button>
    <input type="file" id="avatar-file-input" accept="image/*" style="display:none;">
  `;

  const trigger = document.getElementById('avatar-trigger');
  const fileInput = document.getElementById('avatar-file-input');

  trigger.addEventListener('mouseenter', () => { trigger.style.borderColor = '#C89B3C'; });
  trigger.addEventListener('mouseleave', () => { trigger.style.borderColor = 'transparent'; });
  trigger.addEventListener('click', () => fileInput.click());

  fileInput.addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;

    if (!file.type.startsWith('image/')) { alert('Please choose an image file.'); return; }
    if (file.size > 5 * 1024 * 1024) { alert('Image must be under 5MB.'); return; }

    trigger.style.opacity = '0.5';
    try {
      const extension = (file.name.split('.').pop() || 'jpg').toLowerCase();
      const path = `${profile.id}/avatar.${extension}`;

      const { data: { session } } = await supabaseClient.auth.getSession();
      const url = `${SUPABASE_URL}/storage/v1/object/avatars/${path}`;
      const uploadResult = await new Promise((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.open('POST', url, true);
        xhr.setRequestHeader('Authorization', `Bearer ${session.access_token}`);
        xhr.setRequestHeader('apikey', SUPABASE_ANON_KEY);
        xhr.setRequestHeader('Content-Type', file.type);
        xhr.setRequestHeader('x-upsert', 'true');
        xhr.onload = () => (xhr.status >= 200 && xhr.status < 300) ? resolve() : reject(new Error('Upload failed: ' + xhr.status));
        xhr.onerror = () => reject(new Error('Network error during upload.'));
        xhr.send(file);
      });

      // Public bucket — a stable public URL, not a signed one that
      // would need regenerating. Add a cache-busting query param since
      // the filename never changes on re-upload (x-upsert overwrites
      // it), which browsers would otherwise keep showing the old
      // cached image for.
      const { data: publicUrlData } = supabaseClient.storage.from('avatars').getPublicUrl(path);
      const avatarUrl = publicUrlData.publicUrl + '?t=' + Date.now();

      const { error: updateError } = await supabaseClient.from('profiles').update({ avatar_url: avatarUrl }).eq('id', profile.id);
      if (updateError) throw updateError;

      profile.avatar_url = avatarUrl;
      initAvatar(containerId, profile); // re-render with the new photo
    } catch (err) {
      alert('Could not upload photo: ' + err.message);
      trigger.style.opacity = '1';
    }
  });
}
