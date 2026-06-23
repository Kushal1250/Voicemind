export const resolveUserDisplayName = (user) => {
  if (!user || typeof user !== 'object') return 'User';

  const directCandidates = [
    user.name,
    user.fullName,
    user.displayName,
    user.username,
  ];

  const firstValid = directCandidates.find((value) => typeof value === 'string' && value.trim());
  if (firstValid) return firstValid.trim();

  if (typeof user.email === 'string' && user.email.includes('@')) {
    return user.email.split('@')[0].replace(/[._-]+/g, ' ').trim() || 'User';
  }

  return 'User';
};

export const getDisplayName = resolveUserDisplayName;

export const getUserInitials = (user) => {
  const displayName = resolveUserDisplayName(user);
  const nameParts = displayName
    .split(/\s+/)
    .map((part) => part.trim())
    .filter(Boolean);

  if (nameParts.length > 0 && displayName !== 'User') {
    return nameParts
      .slice(0, 2)
      .map((part) => part.charAt(0).toUpperCase())
      .join('')
      .slice(0, 2);
  }

  if (typeof user?.email === 'string' && user.email.includes('@')) {
    return user.email
      .split('@')[0]
      .replace(/[^a-zA-Z0-9]/g, '')
      .slice(0, 2)
      .toUpperCase() || 'U';
  }

  return 'U';
};

export const truncateEmail = (email, maxLength = 28) => {
  const safeEmail = String(email || '').trim();
  if (!safeEmail) return '';
  if (safeEmail.length <= maxLength) return safeEmail;

  const [localPart, domainPart = ''] = safeEmail.split('@');
  if (!domainPart) return `${safeEmail.slice(0, Math.max(0, maxLength - 1))}…`;

  const keptLocal = Math.max(4, maxLength - domainPart.length - 2);
  return `${localPart.slice(0, keptLocal)}…@${domainPart}`;
};
