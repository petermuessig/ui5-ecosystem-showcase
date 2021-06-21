const approuter = require("@sap/approuter")()
const fs = require("fs")
const path = require("path")
const request = require("request")
const log = require("@ui5/logger").getLogger("server:custommiddleware:cfdestination")

/**
 * Custom UI5 Server middleware "cfdestination"
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
module.exports = ({ resources, options }) => {
    // provide a set of default runtime options
    const effectiveOptions = {
        debug: false,
        port: 5000,
        xsappJson: "./xs-app.json",
        destinations: [],
        allowServices: false,
        authenticationMethod: "none",
        allowLocalDir: false,
        subdomain: null
    }
    // config-time options from ui5.yaml for cfdestination take precedence
    if (options.configuration) {
        Object.assign(effectiveOptions, options.configuration)
    }

    request.debug = effectiveOptions.debug // pass debug flag on to underlying request lib
    process.env.XS_APP_LOG_LEVEL = effectiveOptions.debug ? "DEBUG" : "ERROR"
    // read in the cf config file
    const _xsappJson = path.resolve(resources.rootProject._readers[0]._fsBasePath, "..", effectiveOptions.xsappJson) // respect cwd of containing ui5 server
    const xsappConfig = JSON.parse(fs.readFileSync(_xsappJson, "utf8"))
    const xsappPath = _xsappJson.replace("xs-app.json", "")

    // the default auth mechanism is set to none but the user can pass an auth method using the options
    xsappConfig.authenticationMethod = effectiveOptions.authenticationMethod

    let regExes = []
    // default: ignore routes that point to web apps as they are already hosted by the ui5 tooling,
    // but allow overwriting this behavior via "allowLocalDir"
    xsappConfig.routes = xsappConfig.routes.filter(
        (route) =>
            (effectiveOptions.allowLocalDir || !route.localDir) && (effectiveOptions.allowServices || !route.service)
    )

    xsappConfig.routes.forEach((route) => {
        /* Authentication type should come from route if authenticationMethod is set to "route", otherwise set to "none" */
        if (xsappConfig.authenticationMethod.toLowerCase() === "none") {
            route.authenticationType = "none"
        }

        // ignore /-redirects (e.g. "^/(.*)"
        // a source declaration such as "^/backend/(.*)$" is needed
        if (route.source.match(/.*\/.*\/?.*/)) {
            regExes.push(new RegExp(route.source))
            effectiveOptions.debug
                ? log.info(
                      `adding cf-like destination "${
                          route.destination || "(xs-app.json specific setting)"
                      }" proxying reqs to ${route.source}`
                  )
                : null
        }
    })

    // req-use app-router with config file to run in "shadow" mode
    process.env.destinations = JSON.stringify(effectiveOptions.destinations || [])
    if (effectiveOptions.debug && process.env.destinations.length === 0) {
        log.info(`Provided destinations are empty`)
    }

    approuter.start({
        port: effectiveOptions.port,
        xsappConfig: xsappConfig,
        workingDir: xsappPath || "."
    })
    return (req, res, next) => {
        // check req.path for match with each route.source
        // and proxy to localhost:${effectiveOptions.port}
        let match = false
        let url = ""
        for (let [index, regEx] of regExes.entries()) {
            if (regEx.test(req.path)) {
                match = true
                if (effectiveOptions.subdomain) {
                    // subdomain of the subscribed tenant in multitenancy context
                    url = `${req.protocol}://${effectiveOptions.subdomain}.localhost:${effectiveOptions.port}${req.originalUrl}`
                } else {
                    url = `${req.protocol}://localhost:${effectiveOptions.port}${req.originalUrl}`
                }
                break
            }
        }
        if (match) {
            effectiveOptions.debug ? log.info(`proxying ${req.method} ${req.originalUrl} to ${url}...`) : null
            req.pipe(request(url)).pipe(res)
        } else {
            next()
        }
    }
}
