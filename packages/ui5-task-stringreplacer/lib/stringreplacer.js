const log = require("@ui5/logger").getLogger("builder:customtask:stringreplacer");

// BEGIN: copy of code from ui5-middleware-stringreplacer

const dotenv = require("dotenv");
const escapeRegExp = require('lodash.escaperegexp');
const replaceStream = require("replacestream");

dotenv.config();

// get all environment variables
const envVariables = process.env;

// manage placeholders
let placeholderStrings = {};
function addPlaceholderString(key, value) {
  placeholderStrings[key] = value;
}

// loop through env variables to find keys which are having prefix 'stringreplacer'
if (typeof envVariables === "object") {
  for (key in envVariables) {
    // env variable should start with 'stringreplacer' and should in format 'stringreplacer.placeholder'
    if (/^stringreplacer\.(.+)$/i.test(key)) {
      let placeholderString = /^stringreplacer\.(.+)$/i.exec(key)[1];
      addPlaceholderString(placeholderString, envVariables[key]);
    }
  }
}

// create the helper function to pipe the stream and replace the placeholders
function createReplacePlaceholdersDestination({resource, isDebug}) {
  const replaceStreamRegExp = `(${Object.keys(placeholderStrings).map(placeholder => {
    return escapeRegExp(placeholder);
  }).join("|")})`;
  return replaceStream(new RegExp(replaceStreamRegExp, "g"), (match) => {
    isDebug && log.info(`${resource.getPath()} matched: ${match}; replacing with ${placeholderStrings[match]}`);
    return placeholderStrings[match];
  });
}

// END: copy of code from ui5-middleware-stringreplacer


/**
 * Task to replace strings from files
 *
 * @param {Object} parameters Parameters
 * @param {DuplexCollection} parameters.workspace DuplexCollection to read and write files
 * @param {AbstractReader} parameters.dependencies Reader or Collection to read dependency files
 * @param {Object} parameters.options Options
 * @param {Array} parameters.options.files all file name patterns where replace should occur
 * @param {Array} [parameters.options.strings] Array of objects containing placeholder and replacment text value
 * @returns {Promise<undefined>} Promise resolving with undefined once data has been written
 */
module.exports = function ({ workspace, options }) {

  const isDebug = options.configuration && options.configuration.debug;

  // extract the placeholder strings from the configuration
  if (options.configuration) {
    const { replace } = options.configuration;
    replace && replace.forEach(entry => {
      addPlaceholderString(entry.placeholder, entry.value);
    });
  }

  return workspace
    .byGlob(options.configuration && options.configuration.files)
    .then((allResources) => {
      // replaces all files placeholder strings with replacement text values
      return allResources.map((resource) => {
        // stream replacement only works for UTF-8 resources!
        let stream = resource.getStream();
        stream.setEncoding("utf8");
        stream = stream.pipe(createReplacePlaceholdersDestination({resource, isDebug}));
        resource.setStream(stream);
        return resource;
      });
    })
    .then((processedResources) => {
      return Promise.all(
        processedResources.map((resource) => {
          return workspace.write(resource);
        })
      );
    })
    .catch((err) => {
      log.error(
        "Failed to replace strings. Please check file patterns and string placeholders."
      );
    });
};