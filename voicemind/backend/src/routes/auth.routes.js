const express = require('express');
const jwt = require('jsonwebtoken');
const { body, validationResult } = require('express-validator');
const User = require('../models/User');
const { auth } = require('../middleware/auth');

const router = express.Router();

const sanitizeEmail = (email = '') => String(email).toLowerCase().trim();
const sanitizeDisplayName = (name = '') => String(name).trim();

const buildValidationError = (errors) => ({
  success: false,
  error: {
    code: 'VALIDATION_ERROR',
    message: errors.array()[0]?.msg || 'Validation failed',
    details: errors.array(),
  },
});

const publicUser = (user) => ({
  id: user._id,
  displayName: user.displayName,
  email: user.email,
  role: user.role,
  preferences: user.preferences,
  createdAt: user.createdAt,
  lastLoginAt: user.lastLoginAt,
});

const generateToken = (id) => {
  if (!process.env.JWT_SECRET) throw new Error('JWT_SECRET is missing in backend .env');
  return jwt.sign({ id: String(id) }, process.env.JWT_SECRET, {
    expiresIn: process.env.JWT_EXPIRES_IN || '7d',
  });
};

router.post(
  '/signup',
  [
    body('displayName').trim().notEmpty().withMessage('Display name is required'),
    body('email').isEmail().withMessage('Please provide a valid email'),
    body('password').isLength({ min: 6 }).withMessage('Password must be at least 6 characters'),
  ],
  async (req, res, next) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) return res.status(400).json(buildValidationError(errors));

      const displayName = sanitizeDisplayName(req.body.displayName);
      const email = sanitizeEmail(req.body.email);
      const password = String(req.body.password || '');

      const existingUser = await User.findOne({ email });
      if (existingUser) {
        return res.status(400).json({
          success: false,
          error: { code: 'DUPLICATE_ERROR', message: 'User already exists with this email' },
        });
      }

      const user = await User.create({ displayName, email, passwordHash: password });
      const token = generateToken(user._id);
      return res.status(201).json({ success: true, data: { token, user: publicUser(user) } });
    } catch (error) {
      return next(error);
    }
  }
);

router.post(
  '/login',
  [
    body('email').isEmail().withMessage('Please provide a valid email'),
    body('password').notEmpty().withMessage('Password is required'),
  ],
  async (req, res, next) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) return res.status(400).json(buildValidationError(errors));

      const email = sanitizeEmail(req.body.email);
      const password = String(req.body.password || '');

      const user = await User.findOne({ email }).select('+passwordHash');
      if (!user) {
        return res.status(401).json({
          success: false,
          error: { code: 'INVALID_CREDENTIALS', message: 'Invalid credentials' },
        });
      }

      const isMatch = await user.comparePassword(password);
      if (!isMatch) {
        return res.status(401).json({
          success: false,
          error: { code: 'INVALID_CREDENTIALS', message: 'Invalid credentials' },
        });
      }

      user.lastLoginAt = new Date();
      await user.save();

      const token = generateToken(user._id);
      return res.json({ success: true, data: { token, user: publicUser(user) } });
    } catch (error) {
      return next(error);
    }
  }
);

router.get('/me', auth, async (req, res, next) => {
  try {
    const user = await User.findById(req.user._id);
    if (!user) {
      return res.status(404).json({
        success: false,
        error: { code: 'USER_NOT_FOUND', message: 'User not found' },
      });
    }
    return res.json({ success: true, data: publicUser(user) });
  } catch (error) {
    return next(error);
  }
});

/**
 * PUT /api/auth/me
 *
 * BUG FIX: The original code used a shallow spread:
 *   updateData.preferences = { ...req.user.preferences, ...preferences }
 *
 * This wiped nested sub-objects. Sending { theme: 'dark' } would destroy
 * preferences.notifications entirely because the spread overwrote the whole
 * preferences object with one that had no notifications key.
 *
 * FIX: Build MongoDB $set paths using dot-notation so only the exact fields
 * sent by the client are updated, leaving everything else untouched.
 *   { theme: 'dark' }                      → { 'preferences.theme': 'dark' }
 *   { notifications: { system: false } }   → { 'preferences.notifications.system': false }
 */
router.put('/me', auth, async (req, res, next) => {
  try {
    const { displayName, preferences } = req.body;
    const $set = {};

    if (typeof displayName === 'string' && displayName.trim()) {
      $set.displayName = sanitizeDisplayName(displayName);
    }

    if (preferences && typeof preferences === 'object' && !Array.isArray(preferences)) {
      const flattenPrefs = (obj, prefix = 'preferences') => {
        for (const [key, val] of Object.entries(obj)) {
          const path = `${prefix}.${key}`;
          if (val !== null && typeof val === 'object' && !Array.isArray(val)) {
            flattenPrefs(val, path);
          } else {
            $set[path] = val;
          }
        }
      };
      flattenPrefs(preferences);
    }

    if (Object.keys($set).length === 0) {
      const current = await User.findById(req.user._id);
      return res.json({ success: true, data: publicUser(current) });
    }

    const user = await User.findByIdAndUpdate(
      req.user._id,
      { $set },
      { new: true, runValidators: true }
    );

    return res.json({ success: true, data: publicUser(user) });
  } catch (error) {
    return next(error);
  }
});

module.exports = router;