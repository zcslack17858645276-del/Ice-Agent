const modelEntryPattern = /\.model3\.json$/i;
const modelDirectories = new Set(['xglk', 'miku_free', 'miku_pro']);

export function discoverLive2DModels(files) {
  return [...new Set(files.map((file) => file.replace(/\\/g, '/')))]
    .filter((file) => {
      const [directory, ...rest] = file.split('/');
      return modelDirectories.has(directory) && rest.length > 0 && modelEntryPattern.test(file);
    })
    .sort();
}
