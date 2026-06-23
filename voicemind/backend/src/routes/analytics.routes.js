const express = require('express');
const Meeting = require('../models/Meeting');
const Transcript = require('../models/Transcript');
const QAInteraction = require('../models/QAInteraction');
const { auth } = require('../middleware/auth');

const router = express.Router();

// ─── GET /api/analytics/overview ─────────────────────────────────────────────
router.get('/overview', auth, async (req, res, next) => {
  try {
    const { from, to, deviceId } = req.query;

    const dateQuery = {};
    if (from) dateQuery.$gte = new Date(from);
    if (to)   dateQuery.$lte = new Date(to);

    const query = {};
    if (Object.keys(dateQuery).length > 0) query.createdAt = dateQuery;
    if (deviceId) query.deviceId = deviceId;

    // Transcripts with actual content from completed meetings
    const doneMeetings = await Meeting.find({ ...query, status: { $in: ['completed', 'done', 'ended'] } })
      .select('meetingId').lean();
    const doneMeetingIds = doneMeetings.map((m) => m.meetingId);
    const transcriptQuery = {
      meetingId: { $in: doneMeetingIds },
      fullText: { $exists: true, $ne: '' },
    };

    const [totalMeetings, durationResult, qaCount, activeRecordings, transcriptsCount] =
      await Promise.all([
        Meeting.countDocuments(query),

        // FIX: only average meetings that actually have a non-zero durationSec
        // This prevents the 0-default meetings from dragging the average to 0
        Meeting.aggregate([
          {
            $match: {
              ...query,
              'stats.durationSec': { $gt: 0 }, // ← only include meetings with real duration
            },
          },
          {
            $group: {
              _id: null,
              avg:   { $avg: '$stats.durationSec' },
              total: { $sum: '$stats.durationSec' },
            },
          },
        ]),

        QAInteraction.countDocuments(from ? { createdAt: dateQuery } : {}),
        Meeting.countDocuments({ ...query, status: 'recording' }),
        Transcript.countDocuments(transcriptQuery),
      ]);

    const successCount = await Meeting.countDocuments({ ...query, status: { $in: ['completed', 'done', 'ended'] } });
    const successRate =
      totalMeetings > 0 ? (successCount / totalMeetings) * 100 : 0;

    // Chunk failure rate from meetings that finished
    const chunkStats = await Meeting.aggregate([
      { $match: { ...query, 'stats.chunksTotal': { $gt: 0 } } },
      {
        $group: {
          _id:           null,
          totalChunks:   { $sum: '$stats.chunksTotal' },
          failedChunks:  { $sum: '$stats.chunksFailed' },
        },
      },
    ]);
    const chunkFailureRate =
      chunkStats[0]?.totalChunks > 0
        ? (chunkStats[0].failedChunks / chunkStats[0].totalChunks) * 100
        : 0;

    res.json({
      success: true,
      data: {
        totalMeetings,
        totalDurationSec:  Math.round(durationResult[0]?.total || 0),
        avgDuration:       Math.round(durationResult[0]?.avg   || 0), // now correctly ignores 0-duration meetings
        transcriptsCount,
        completedTranscriptSessions: transcriptsCount,
        qaInteractions:    qaCount,
        activeRecordings,
        successRate:       Math.round(successRate * 100) / 100,
        chunkFailureRate:  Math.round(chunkFailureRate * 100) / 100,
      },
    });
  } catch (error) {
    next(error);
  }
});

// ─── GET /api/analytics/meetings-timeseries ───────────────────────────────────
router.get('/meetings-timeseries', auth, async (req, res, next) => {
  try {
    const { from, to, bucket = 'day' } = req.query;

    const dateQuery = {};
    if (from) dateQuery.$gte = new Date(from);
    if (to)   dateQuery.$lte = new Date(to);

    const groupFormat = bucket === 'week' ? '%Y-%U' : '%Y-%m-%d';

    const data = await Meeting.aggregate([
      {
        $match: Object.keys(dateQuery).length > 0 ? { createdAt: dateQuery } : {},
      },
      {
        $group: {
          _id:         { $dateToString: { format: groupFormat, date: '$createdAt' } },
          meetings:    { $sum: 1 },
          durationAvg: { $avg: '$stats.durationSec' },
          failures:    { $sum: { $cond: [{ $in: ['$status', ['failed', 'error']] }, 1, 0] } },
          transcripts: {
            $sum: {
              $cond: [
                { $in: ['$status', ['completed', 'done', 'ended']] },
                1,
                0,
              ],
            },
          },
        },
      },
      { $sort: { _id: 1 } },
    ]);

    res.json({
      success: true,
      data: data.map((d) => ({
        date:        d._id,
        meetings:    d.meetings,
        durationAvg: Math.round(d.durationAvg || 0),
        failures:    d.failures,
        transcripts: d.transcripts,
      })),
    });
  } catch (error) {
    next(error);
  }
});

// ─── GET /api/analytics/qa ────────────────────────────────────────────────────
router.get('/qa', auth, async (req, res, next) => {
  try {
    const { from, to } = req.query;

    const dateQuery = {};
    if (from) dateQuery.$gte = new Date(from);
    if (to)   dateQuery.$lte = new Date(to);

    const data = await QAInteraction.aggregate([
      {
        $match: Object.keys(dateQuery).length > 0 ? { createdAt: dateQuery } : {},
      },
      {
        $group: {
          _id:          { $dateToString: { format: '%Y-%m-%d', date: '$createdAt' } },
          interactions: { $sum: 1 },
        },
      },
      { $sort: { _id: 1 } },
    ]);

    res.json({
      success: true,
      data: data.map((d) => ({
        date:         d._id,
        interactions: d.interactions,
      })),
    });
  } catch (error) {
    next(error);
  }
});

module.exports = router;