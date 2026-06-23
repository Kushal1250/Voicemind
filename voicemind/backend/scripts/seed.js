require('dotenv').config();

const mongoose = require('mongoose');
const connectDB = require('../src/config/db');
const User = require('../src/models/User');
const Device = require('../src/models/Device');

async function seed() {
  try {
    await connectDB();

    const adminEmail = 'admin@voicemind.local';
    const userEmail = 'demo@voicemind.local';

    const existingAdmin = await User.findOne({ email: adminEmail });
    if (!existingAdmin) {
      await User.create({
        name: 'VoiceMind Admin',
        email: adminEmail,
        password: 'admin123',
        role: 'admin'
      });
      console.log(`✅ Created admin user: ${adminEmail} / admin123`);
    }

    const existingDemo = await User.findOne({ email: userEmail });
    if (!existingDemo) {
      await User.create({
        name: 'VoiceMind Demo',
        email: userEmail,
        password: 'demo123',
        role: 'user'
      });
      console.log(`✅ Created demo user: ${userEmail} / demo123`);
    }

    const existingDevice = await Device.findOne({ deviceId: 'esp32-room-01' });
    if (!existingDevice) {
      await Device.create({
        deviceId: 'esp32-room-01',
        name: 'VoiceMind ESP32 Room Mic',
        type: 'esp32',
        status: 'offline',
        firmwareVersion: '2.0.0',
        sampleRate: 16000
      });
      console.log('✅ Created demo device: esp32-room-01');
    }

    console.log('🎉 Seed complete');
    await mongoose.connection.close();
    process.exit(0);
  } catch (error) {
    console.error('❌ Seed failed:', error);
    process.exit(1);
  }
}

seed();