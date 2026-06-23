const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

const userSchema = new mongoose.Schema({
  displayName: {
    type: String,
    required: [true, 'Please provide a display name'],
    trim: true,
    maxlength: [50, 'Display name cannot be more than 50 characters']
  },
  email: {
    type: String,
    required: [true, 'Please provide an email'],
    unique: true,
    lowercase: true,
    trim: true,
    match: [/\S+@\S+\.\S+/, 'Please provide a valid email']
  },
  passwordHash: {
    type: String,
    required: [true, 'Please provide a password'],
    minlength: [6, 'Password must be at least 6 characters'],
    select: false
  },
  role: {
    type: String,
    enum: ['user', 'admin'],
    default: 'user'
  },
  preferences: {
    theme: {
      type: String,
      enum: ['light', 'dark', 'system'],
      default: 'system'
    },
    realtimeMode: {
      type: String,
      enum: ['auto', 'realtime', 'polling'],
      default: 'auto'
    },
    notifications: {
      system: { type: Boolean, default: true },
      device: { type: Boolean, default: true },
      meeting: { type: Boolean, default: true },
      toastThreshold: {
        type: String,
        enum: ['all', 'important', 'critical'],
        default: 'important'
      },
      quietHours: {
        enabled: { type: Boolean, default: false },
        from: { type: String, default: '22:00' },
        to: { type: String, default: '08:00' }
      }
    }
  },
  lastLoginAt: {
    type: Date
  },
  createdAt: {
    type: Date,
    default: Date.now
  }
}, {
  timestamps: true
});

// Hash password before saving
userSchema.pre('save', async function(next) {
  if (!this.isModified('passwordHash')) return next();
  this.passwordHash = await bcrypt.hash(this.passwordHash, 12);
  next();
});

// Compare password method
userSchema.methods.comparePassword = async function(candidatePassword) {
  return await bcrypt.compare(candidatePassword, this.passwordHash);
};

// Remove password from JSON output
userSchema.methods.toJSON = function() {
  const obj = this.toObject();
  delete obj.passwordHash;
  return obj;
};

module.exports = mongoose.model('User', userSchema);
