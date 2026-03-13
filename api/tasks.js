// Tasks API - extract tasks from all agents
const agentsData = require('./agents').agentsData || [
  {
    type: "muse",
    status: "completed",
    tasks: [
      {date: "2026-03-12", description: "Generated 3 Reel concepts for dance trend", status: "completed", time: "Today"},
      {date: "2026-03-11", description: "Caption writing batch for 5 posts", status: "completed", time: "Yesterday"},
      {date: "2026-03-10", description: "Created visual mood board for March content", status: "completed", time: "2d ago"},
      {date: "2026-03-09", description: "Script for soft girl era Reel", status: "completed", time: "3d ago"}
    ]
  },
  {
    type: "echo",
    status: "completed",
    tasks: [
      {date: "2026-03-12", description: "Monitored engagement on latest 3 Reels", status: "completed", time: "Today"},
      {date: "2026-03-11", description: "Fetched following list for inspiration feed", status: "completed", time: "Yesterday"},
      {date: "2026-03-10", description: "Analyzed best posting times", status: "completed", time: "2d ago"},
      {date: "2026-03-09", description: "Competitor analysis for @yeri_mood", status: "completed", time: "3d ago"}
    ]
  },
  {
    type: "bolt",
    status: "working",
    tasks: [
      {date: "2026-03-12", description: "Fixing Saka Dashboard bugs", status: "in_progress", time: "Now"},
      {date: "2026-03-12", description: "Added Agent Task Dashboard", status: "completed", time: "Today"},
      {date: "2026-03-11", description: "Dashboard refactor to real-time API", status: "completed", time: "Yesterday"},
      {date: "2026-03-11", description: "Created audio-transcribe skill", status: "completed", time: "Yesterday"}
    ]
  },
  {
    type: "saga",
    status: "idle",
    tasks: [
      {date: "2026-03-11", description: "Wrote narrative for brand story highlight", status: "completed", time: "Yesterday"},
      {date: "2026-03-09", description: "Developed character voice guide", status: "completed", time: "3d ago"}
    ]
  },
  {
    type: "nova",
    status: "working",
    tasks: [
      {date: "2026-03-12", description: "Researching trending audio for this week", status: "in_progress", time: "Now"},
      {date: "2026-03-10", description: "Hashtag research for dance content", status: "completed", time: "2d ago"}
    ]
  },
  {
    type: "atlas",
    status: "completed",
    tasks: [
      {date: "2026-03-11", description: "Generated weekly engagement report", status: "completed", time: "Yesterday"},
      {date: "2026-03-09", description: "Follower growth analysis", status: "completed", time: "3d ago"}
    ]
  }
];

const agentNames = {
  muse: 'Muse',
  echo: 'Echo',
  bolt: 'Bolt',
  saga: 'Saga',
  nova: 'Nova',
  atlas: 'Atlas'
};

module.exports = (req, res) => {
  const tasks = [];

  agentsData.forEach(agent => {
    (agent.tasks || []).forEach((task, idx) => {
      tasks.push({
        id: `${agent.type}-${idx}`,
        title: task.description,
        agent: agentNames[agent.type] || agent.type,
        agentType: agent.type,
        status: task.status === 'completed' ? 'done' : (task.status === 'in_progress' ? 'progress' : 'todo'),
        time: task.time,
        date: task.date
      });
    });
  });

  res.status(200).json({ success: true, data: tasks });
};
