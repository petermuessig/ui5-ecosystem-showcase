const path = require("path")
const log = require("@ui5/logger").getLogger("server:custommiddleware:livereload")

/**
 * Custom UI5 Server middleware example
 *
 * @param {Object} parameters Parameters
 * @param {Object} parameters.resources Resource collections
 * @param {module:@ui5/fs.AbstractReader} parameters.resources.all Reader or Collection to read resources of the
 *                                        root project and its dependencies
 * @param {module:@ui5/fs.AbstractReader} parameters.resources.rootProject Reader or Collection to read resources of
 *                                        the project the server is started in
 * @param {module:@ui5/fs.AbstractReader} parameters.resources.dependencies Reader or Collection to read resources of
 *                                        the projects dependencies
 * @param {Object} parameters.options Options
 * @param {string} [parameters.options.configuration] Custom server middleware configuration if given in ui5.yaml
 * @returns {function} Middleware function to use
 */
module.exports = function createMiddleware({ resources, options }) {
    return (req, res, next) => {
        const sIndexFile = options && options.index ? `${options.index}` : "index.html"
        if (req.path === "/") {
            options && options.debug ? log.info(`serving ${sIndexFile}!`) : null
            return resources.rootProject
                .byPath(`/${sIndexFile}`)
                .then(indexFile => {
                    // read file into string
                    return indexFile.getString()
                })
                .then(source => {
                    res.type(".html")
                    res.end(source)
                })
        }
        next()
    }
}
