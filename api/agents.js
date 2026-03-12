const fs = require('fs');
const path = require('path');

module.exports = (req, res) => {
  try {
    // Read agents data from JSON file
    const dataPath = path.join(process.cwd(), 'agents-data.json');
    const data = JSON.parse(fs.readFileSync(dataPath, 'utf8'));

    res.status(200).json({
      success: true,
      data: data.agents
    });
  } catch (e) {
    res.status(500).json({
      success: false,
      error: e.message
    });
  }
};
